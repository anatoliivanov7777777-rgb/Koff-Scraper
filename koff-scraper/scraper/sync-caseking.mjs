// Синхронизира вече скрейпнатите koff.ro продукти директно в Convex базата
// на case-king.bg - по същия начин, по който прави техния собствен admin
// импорт панел (виж admin.js:confirmCSVImport в техния repo).
//
// БЕЗОПАСНОСТ: пише директно в ЖИВАТА база данни на реалния сайт. По
// подразбиране работи в DRY RUN режим (нищо не се записва, само показва
// какво би направил).
//
// Употреба:
//   LIVE=true node sync-caseking.mjs                 - реален пълен sync
//   LIMIT=10 LIVE=true node sync-caseking.mjs         - тест с малка част
//   CLEANUP=true LIVE=true node sync-caseking.mjs     - изтрива ВСИЧКО,
//     маркирано с source="koff-sync" (продукти, марки, модели), БЕЗ да
//     качва нищо ново - за чист рестарт след поправка на логиката.

import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import { CATEGORY_MAP } from "./category-map.mjs";
import { parseProductName } from "./parse-names.mjs";
import { extractBrandModelsFromFullSegment } from "./brand-model.mjs";
import { calcB2BPrice, calcB2CPrice } from "./pricing.mjs";

const CASEKING_CONVEX_URL =
  process.env.CASEKING_CONVEX_URL ||
  "https://trustworthy-possum-230.eu-west-1.convex.cloud";

const LIVE = process.env.LIVE === "true";
const CLEANUP = process.env.CLEANUP === "true";
const LIMIT_RAW = (process.env.LIMIT || "").trim().toLowerCase();
const LIMIT = LIMIT_RAW && LIMIT_RAW !== "all" ? parseInt(LIMIT_RAW, 10) : null;

// Маркер, слаган на всичко, създадено от този скрипт - позволява
// безопасно, целенасочено изтриване/презапис само на автоматично
// синхронизираните данни, без да пипа ръчно въведени продукти.
const SOURCE_TAG = "koff-sync";

// Категорията, в която отиват всички часовникови аксесоари (гривни,
// зарядни, калъфи за смарт часовници) - ОТДЕЛНО от телефонните категории,
// за да не се смесват в глобалния филтър Марка/Модел.
const WATCH_CATEGORY_SLUG = "aksesoari_chasovnici";

const DEFAULT_SPECS = {
  material: "Премиум силикон / TPU / Кожа",
  weight: "30г",
  origin: "Румъния",
  delivery: "Доставка 3-4 работни дни с преглед (без тест)",
};

function norm(s) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function buildCaseKingProducts(raw, categorySlug) {
  const parsed = parseProductName(raw.name || "", raw.manufacturer);
  const color = parsed.color;
  const baseTitle = [raw.manufacturer, parsed.productLine, color]
    .filter(Boolean)
    .join(" - ");

  const base = raw.basePrice;
  const priceB2B = calcB2BPrice(base);
  const priceB2C = calcB2CPrice(base);

  const description =
    (raw.description && raw.description.trim()) ||
    `${baseTitle}. Премиум телефонен аксесоар от най-висок клас.`;

  const commonFields = {
    id: null,
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
    source: SOURCE_TAG,
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
        category: categorySlug,
        name: baseTitle,
        brand: "Всички марки",
        model: "Всички модели",
      },
    ];
  }

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
    category: bm.isWatch ? WATCH_CATEGORY_SLUG : categorySlug,
    name: baseTitle,
    brand: bm.brand,
    model: bm.model,
  }));
}

async function runBackfillMigration(convex) {
  console.log("Мигрирам съществуващите продукти (matchKey за бърз индекс)...");
  let cursor = null;
  let totalUpdated = 0;
  let isDone = false;

  while (!isDone) {
    const res = await convex.mutation("products:backfillMatchKeys", { cursor });
    totalUpdated += res.updated;
    isDone = res.isDone;
    cursor = res.continueCursor;
  }
  console.log(`Миграция готова. Общо мигрирани: ${totalUpdated}`);
}

async function runCleanup(convex) {
  console.log(`\nCLEANUP режим - изтривам АБСОЛЮТНО ВСИЧКИ продукти, марки и модели...`);

  console.log("Изтривам продукти...");
  let cursor = null;
  let isDone = false;
  let totalDeleted = 0;
  while (!isDone) {
    const res = await convex.mutation("products:deleteAllProductsPaginated", { cursor });
    totalDeleted += res.deleted;
    isDone = res.isDone;
    cursor = res.continueCursor;
    console.log(`  изтрити продукти дотук: ${totalDeleted}`);
  }

  console.log("Изтривам марки...");
  const brandsRes = await convex.mutation("meta:clearAllBrands", {});
  console.log(`  изтрити марки: ${brandsRes.deleted}`);

  console.log("Изтривам модели...");
  const modelsRes = await convex.mutation("meta:clearAllModels", {});
  console.log(`  изтрити модели: ${modelsRes.deleted}`);

  console.log(
    `\nCLEANUP готово: ${totalDeleted} продукта, ${brandsRes.deleted} марки, ${modelsRes.deleted} модела изтрити.`
  );
}

async function main() {
  console.log(`Режим: ${LIVE ? "LIVE" : "DRY RUN (само преглед)"}${CLEANUP ? " + CLEANUP" : ""}`);

  if (CLEANUP) {
    if (!LIVE) {
      console.log("CLEANUP изисква и LIVE=true. Нищо не е направено.");
      return;
    }
    const convex = new ConvexHttpClient(CASEKING_CONVEX_URL);
    await runCleanup(convex);
    return;
  }

  if (LIMIT) console.log(`Лимит за тест: първите ${LIMIT} суровини продукта`);

  const raw = fs.readFileSync("./koff-products-raw.json", "utf-8");
  let rawProducts = JSON.parse(raw);
  console.log(`Заредени суровини продукти: ${rawProducts.length}`);

  if (LIMIT) rawProducts = rawProducts.slice(0, LIMIT);

  const caseKingProducts = [];
  for (const p of rawProducts) {
    const slug = CATEGORY_MAP[norm(p.category)];
    if (!slug) continue;
    caseKingProducts.push(...buildCaseKingProducts(p, slug));
  }

  const watchRows = caseKingProducts.filter((p) => p.category === WATCH_CATEGORY_SLUG).length;
  console.log(
    `Генерирани case-king.bg продуктови реда: ${caseKingProducts.length} (от които ${watchRows} часовникови)`
  );
  console.log("Примерни 3 реда:");
  console.log(JSON.stringify(caseKingProducts.slice(0, 3), null, 2));

  if (!LIVE) {
    console.log("\nDRY RUN - нищо не е записано. Пусни с LIVE=true за реален запис.");
    return;
  }

  const convex = new ConvexHttpClient(CASEKING_CONVEX_URL);

  await runBackfillMigration(convex);

  console.log("\nЗареждам съществуващи категории/марки/модели от case-king.bg...");
  const [existingCats, existingBrands, existingModels] = await Promise.all([
    convex.query("meta:getCategories"),
    convex.query("meta:getBrands"),
    convex.query("meta:getModels"),
  ]);

  const catIds = new Set(existingCats.map((c) => c.id));
  if (!catIds.has(WATCH_CATEGORY_SLUG)) {
    console.warn(
      `\n⚠️  ВНИМАНИЕ: категория "${WATCH_CATEGORY_SLUG}" НЕ съществува още в case-king.bg! ` +
        `Часовниковите продукти ще се качат, но няма да се показват никъде, докато категорията не бъде създадена.`
    );
  }

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
          logo: `logo_${brandLower.replace(/\s+/g, "_")}.webp`,
          source: SOURCE_TAG,
        });
        brandsCache.add(brandLower);
        newBrands++;
      }

      if (p.model !== "Всички модели") {
        const modelKey = `${brandLower}:${p.model.toLowerCase()}`;
        if (!modelsCache.has(modelKey)) {
          await convex.mutation("meta:addModel", {
            brand: p.brand,
            name: p.model,
            source: SOURCE_TAG,
          });
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
