// Синхронизира вече скрейпнатите koff.ro продукти директно в Convex базата
// на case-king.bg - по същия начин, по който прави техния собствен admin
// импорт панел (виж admin.js:confirmCSVImport в техния repo).
//
// БЕЗОПАСНОСТ: пише директно в ЖИВАТА база данни на реалния сайт. По
// подразбиране работи в DRY RUN режим (нищо не се записва, само показва
// какво би направил). За реален запис: LIVE=true node sync-caseking.mjs
// За тест с малка част: LIMIT=10 LIVE=true node sync-caseking.mjs

import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import { CATEGORY_MAP } from "./category-map.mjs";
import { parseProductName } from "./parse-names.mjs";
import { extractBrandModelsFromFullSegment } from "./brand-model.mjs";

const CASEKING_CONVEX_URL =
  process.env.CASEKING_CONVEX_URL ||
  "https://trustworthy-possum-230.eu-west-1.convex.cloud";

const LIVE = process.env.LIVE === "true";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;

const B2B_MARKUP = 1.6;
const B2C_MARKUP = 1.8;

// Дефолти, ИДЕНТИЧНИ с тези, които техният собствен admin.js import панел
// ползва, когато липсват данни - за консистентност с останалите продукти
// в базата им.
const DEFAULT_SPECS = {
  material: "Премиум силикон / TPU / Кожа",
  weight: "30г",
  origin: "Румъния",
  delivery: "Доставка 3-4 работни дни с преглед (без тест)",
};

function norm(s) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

// Превръща един суров koff.ro продукт в 1 или повече готови за case-king.bg
// продуктови обекта (по един на всеки съвместим модел, ако продуктът пасва
// на няколко устройства).
function buildCaseKingProducts(raw, categorySlug) {
  const parsed = parseProductName(raw.name || "", raw.manufacturer);
  const color = parsed.color;
  const baseTitle = [raw.manufacturer, parsed.productLine, color]
    .filter(Boolean)
    .join(" - ");

  const base = raw.basePrice;
  const priceB2B = Math.round(base * B2B_MARKUP * 100) / 100;
  const priceB2C = Math.round(base * B2C_MARKUP * 100) / 100;

  const description =
    (raw.description && raw.description.trim()) ||
    `${baseTitle}. Премиум телефонен аксесоар от най-висок клас.`;

  const commonFields = {
    id: null,
    category: categorySlug,
    image: raw.imageUrl || "assets/logo.webp",
    images: raw.imageUrl ? [raw.imageUrl] : [],
    rating: 5,
    tag: null,
    description,
    specs: DEFAULT_SPECS,
    priceB2C,
    oldPriceB2C: null,
    priceB2B,
    oldPriceB2B: null,
  };

  let brandModels = [];
  if (parsed.rawModelSegment) {
    brandModels = extractBrandModelsFromFullSegment(parsed.rawModelSegment).filter(
      (bm) => bm.brand && bm.model
    );
  }

  if (brandModels.length === 0) {
    return [
      {
        ...commonFields,
        name: baseTitle,
        brand: "Всички марки",
        model: "Всички модели",
      },
    ];
  }

  // Премахваме дубликати (брандMoves) в рамките на един продукт
  const seen = new Set();
  const unique = [];
  for (const bm of brandModels) {
    const key = `${bm.brand}|${bm.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(bm);
    }
  }

  return unique.map((bm) => ({
    ...commonFields,
    name: baseTitle,
    brand: bm.brand,
    model: bm.model,
  }));
}

async function main() {
  console.log(`Режим: ${LIVE ? "LIVE (ще записва в базата!)" : "DRY RUN (само преглед)"}`);
  if (LIMIT) console.log(`Лимит за тест: първите ${LIMIT} суровини продукта`);

  const raw = fs.readFileSync("./koff-products-raw.json", "utf-8");
  let rawProducts = JSON.parse(raw);
  console.log(`Заредени суровини продукти: ${rawProducts.length}`);

  if (LIMIT) rawProducts = rawProducts.slice(0, LIMIT);

  const caseKingProducts = [];
  for (const p of rawProducts) {
    const slug = CATEGORY_MAP[norm(p.category)];
    if (!slug) continue; // все още не мапната категория - пропускаме засега
    caseKingProducts.push(...buildCaseKingProducts(p, slug));
  }

  console.log(`Генерирани case-king.bg продуктови реда: ${caseKingProducts.length}`);
  console.log("Примерни 3 реда:");
  console.log(JSON.stringify(caseKingProducts.slice(0, 3), null, 2));

  if (!LIVE) {
    console.log("\nDRY RUN - нищо не е записано. Пусни с LIVE=true за реален запис.");
    return;
  }

  const convex = new ConvexHttpClient(CASEKING_CONVEX_URL);

  console.log("\nЗареждам съществуващи категории/марки/модели от case-king.bg...");
  const [existingCats, existingBrands, existingModels] = await Promise.all([
    convex.query("meta:getCategories"),
    convex.query("meta:getBrands"),
    convex.query("meta:getModels"),
  ]);

  const brandsCache = new Set(existingBrands.map((b) => b.name.toLowerCase()));
  const modelsCache = new Set(
    existingModels.map((m) => `${m.brand.toLowerCase()}:${m.name.toLowerCase()}`)
  );
  console.log(
    `Намерени: ${existingCats.length} категории, ${existingBrands.length} марки, ${existingModels.length} модела`
  );

  let newBrands = 0;
  let newModels = 0;

  for (const p of caseKingProducts) {
    if (p.brand !== "Всички марки") {
      const brandLower = p.brand.toLowerCase();
      if (!brandsCache.has(brandLower)) {
        await convex.mutation("meta:addBrand", {
          name: p.brand,
          logo: `logo_${brandLower}.webp`,
        });
        brandsCache.add(brandLower);
        newBrands++;
      }

      if (p.model !== "Всички модели") {
        const modelKey = `${brandLower}:${p.model.toLowerCase()}`;
        if (!modelsCache.has(modelKey)) {
          await convex.mutation("meta:addModel", { brand: p.brand, name: p.model });
          modelsCache.add(modelKey);
          newModels++;
        }
      }
    }
  }
  console.log(`Нови марки създадени: ${newBrands}, нови модели създадени: ${newModels}`);

  console.log("\nКачвам продукти на партиди по 100...");
  let totalCreated = 0;
  let totalUpdated = 0;
  const CHUNK = 100;
  for (let i = 0; i < caseKingProducts.length; i += CHUNK) {
    const chunk = caseKingProducts.slice(i, i + CHUNK);
    const res = await convex.mutation("products:upsertBatch", { products: chunk });
    totalCreated += res.createdCount || 0;
    totalUpdated += res.updatedCount || 0;
    console.log(
      `  партида ${i / CHUNK + 1}: +${res.createdCount} нови, ${res.updatedCount} обновени`
    );
  }

  console.log(`\nГотово! Общо нови: ${totalCreated}, общо обновени: ${totalUpdated}`);
}

main().catch((err) => {
  console.error("Синхронизацията гръмна:", err);
  process.exit(1);
});
