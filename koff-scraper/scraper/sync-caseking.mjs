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
//   Cleanup is deliberately unavailable to automated synchronization.

import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import { pathToFileURL } from "node:url";

const OWNED_CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";
const CASEKING_CONVEX_URL = process.env.CASEKING_CONVEX_URL;
const CASEKING_SYNC_SECRET = process.env.CASEKING_SYNC_SECRET;

const LIVE = process.env.LIVE === "true";
const CLEANUP = process.env.CLEANUP === "true";
if (CLEANUP) throw new Error("CLEANUP is disabled for the Koff → CaseKing sync");
if (CASEKING_CONVEX_URL !== OWNED_CASEKING_CONVEX_URL) {
  throw new Error("CASEKING_CONVEX_URL must point to the owned CaseKing deployment");
}
if (LIVE && (!CASEKING_SYNC_SECRET || CASEKING_SYNC_SECRET.length < 32
  || CASEKING_SYNC_SECRET.length > 512 || /^ck2_(admin|user)_/.test(CASEKING_SYNC_SECRET))) {
  throw new Error("CASEKING_SYNC_SECRET is required for live synchronization");
}
const SYNC_OPERATIONS = new Set([
  "products:backfillMatchKeys",
  "products:upsertBatch",
  "meta:addBrand",
  "meta:addModel",
  "meta:countProductsByCategory",
]);
function syncMutation(convex, operation, args) {
  if (!SYNC_OPERATIONS.has(operation)) throw new Error("Operation is not approved for machine sync");
  return convex.mutation(operation, { ...args, syncSecret: CASEKING_SYNC_SECRET });
}
const LIMIT_RAW = (process.env.LIMIT || "").trim().toLowerCase();
const LIMIT = LIMIT_RAW && LIMIT_RAW !== "all" ? parseInt(LIMIT_RAW, 10) : null;

// Маркер, слаган на всичко, създадено от този скрипт - позволява
// безопасно, целенасочено изтриване/презапис само на автоматично
// синхронизираните данни, без да пипа ръчно въведени продукти.
// The pure normalization logic now lives in its own side-effect-free
// module so the staging dry-run can reuse it without tripping this file's
// production-target guard. Same functions, same output - see
// test/normalization-parity.test.mjs.
import {
  SOURCE_TAG,
  WATCH_CATEGORY_SLUG,
  ACCESSORY_CATEGORY_SLUGS,
  ACCESSORY_BRAND_CANONICAL,
  DEFAULT_SPECS,
  norm,
  resolveCategorySlug,
  deviceLabel,
  isSellable,
  buildCaseKingProducts,
} from "./caseking-product-normalization.mjs";

// Re-exported so this module's public surface is unchanged for the existing
// suites (sync-caseking-exports / device-labels / naming-engine / product-id /
// public-maker / trust-accuracy / availability), which import these names from
// here. Same functions, same identity - nothing is reimplemented.
export { resolveCategorySlug, deviceLabel, isSellable, buildCaseKingProducts };

async function runBackfillMigration(convex) {
  console.log("Мигрирам съществуващите продукти (matchKey за бърз индекс)...");
  let cursor = null;
  let totalUpdated = 0;
  let isDone = false;

  while (!isDone) {
    const res = await syncMutation(convex, "products:backfillMatchKeys", { cursor });
    totalUpdated += res.updated;
    isDone = res.isDone;
    cursor = res.continueCursor;
  }
  console.log(`Миграция готова. Общо мигрирани: ${totalUpdated}`);
}

async function refreshCategoryCounts(convex) {
  console.log("\nПреизчислявам броячите на категориите...");
  let cursor = null;
  let countsSoFar = {};
  let isDone = false;

  while (!isDone) {
    const res = await syncMutation(convex, "meta:countProductsByCategory", {
      cursor,
      countsSoFar,
    });
    countsSoFar = res.counts;
    isDone = res.isDone;
    cursor = res.continueCursor;
  }

  const entries = Object.entries(countsSoFar).sort((a, b) => b[1] - a[1]);
  console.log("Броячи по категории:");
  for (const [cat, n] of entries) {
    console.log(`  ${String(n).padStart(6)}  ${cat}`);
  }
  return countsSoFar;
}

async function main() {
  console.log(`Режим: ${LIVE ? "LIVE" : "DRY RUN (само преглед)"}`);

  if (LIMIT) console.log(`Лимит за тест: първите ${LIMIT} суровини продукта`);

  const raw = fs.readFileSync("./koff-products-raw.json", "utf-8");
  let rawProducts = JSON.parse(raw);
  console.log(`Заредени суровини продукти: ${rawProducts.length}`);

  // ПРЕДПАЗИТЕЛ за автоматичните нощни run-ове: ако koff.ro върне
  // подозрително малко продукти (счупен логин, сменен API, срив), спираме
  // ПРЕДИ да пипнем живия сайт. При тест с LIMIT проверката се пропуска.
  // Заобикаля се с FORCE=true, ако спадът е реален.
  const MIN_RAW = parseInt(process.env.MIN_RAW_PRODUCTS || "10000", 10);
  if (LIVE && !LIMIT && process.env.FORCE !== "true" && rawProducts.length < MIN_RAW) {
    console.error(
      `\n❌ СПРЯНО: скрейпнати са само ${rawProducts.length} продукта, ` +
        `а очакваме поне ${MIN_RAW}. Вероятно скрейпването е гръмнало.\n` +
        `Живият сайт НЕ е пипнат. Ако спадът е реален, пусни пак с FORCE=true.`
    );
    process.exit(1);
  }

  if (LIMIT) rawProducts = rawProducts.slice(0, LIMIT);

  const caseKingProducts = [];
  const unmappedCats = new Map(); // koff.ro категория -> брой продукти
  const mappedCats = new Map(); // слъг -> брой суровини продукти
  for (const p of rawProducts) {
    const koffCat = norm(p.category);
    const slug = resolveCategorySlug(p);
    if (!slug) {
      unmappedCats.set(koffCat, (unmappedCats.get(koffCat) || 0) + 1);
      continue;
    }
    mappedCats.set(slug, (mappedCats.get(slug) || 0) + 1);
    caseKingProducts.push(...buildCaseKingProducts(p, slug));
  }

  // ДИАГНОСТИКА: кои koff.ro категории се изхвърлят, защото ги няма в
  // category-map.mjs. Точно те са причината секции на сайта да са празни.
  const unmappedTotal = [...unmappedCats.values()].reduce((a, b) => a + b, 0);
  console.log(
    `\n--- НЕПОКРИТИ koff.ro категории: ${unmappedCats.size} броя, ${unmappedTotal} продукта ---`
  );
  for (const [cat, n] of [...unmappedCats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${cat}`);
  }

  console.log(`\n--- ПОКРИТИ категории (суровини продукти по слъг) ---`);
  for (const [slug, n] of [...mappedCats.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${slug}`);
  }
  console.log("");

  const watchRows = caseKingProducts.filter((p) => p.category === WATCH_CATEGORY_SLUG).length;
  const accRows = caseKingProducts.filter((p) => ACCESSORY_CATEGORY_SLUGS.has(p.category)).length;
  console.log(
    `Генерирани case-king.bg продуктови реда: ${caseKingProducts.length} ` +
      `(${watchRows} часовникови, ${accRows} аксесоарни по марка)`
  );

  // Кои марки аксесоари са разпознати - полезно за проверка дали
  // ACCESSORY_BRAND_CANONICAL не пропуска дублирани изписвания.
  const accBrands = [
    ...new Set(
      caseKingProducts
        .filter((p) => ACCESSORY_CATEGORY_SLUGS.has(p.category))
        .map((p) => p.brand)
    ),
  ].sort();
  console.log(`Марки аксесоари (${accBrands.length}): ${accBrands.join(", ")}`);
  // По един примерен ред от всяка категория (само ключовите полета -
  // пълният JSON залива лога).
  console.log("Примерен ред от всяка категория:");
  const shown = new Set();
  for (const p of caseKingProducts) {
    if (shown.has(p.category)) continue;
    shown.add(p.category);
    console.log(
      `  [${p.category}] марка="${p.brand}" модел="${p.model}" | ${p.name}`
    );
  }

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
    // Only SELLABLE rows may introduce NEW brand/model metadata.
    //
    // A zero-stock (or unverified-stock) row is one of two things: an item
    // CaseKing already sells, whose brand/model metadata therefore already
    // exists from its earlier sellable state; or a brand-new supplier item
    // that products:upsertBatch will refuse to create (the availability
    // guard). Creating dropdown entries for the latter would advertise
    // brands and models with no buyable product behind them.
    //
    // This filter is metadata-only. The product upsert further below still
    // receives EVERY generated row, because existing products must keep
    // receiving stock updates - including stock = 0, so a sold-out item
    // stops showing as available.
    if (!isSellable(p)) continue;

    if (p.brand !== "Всички марки") {
      const brandLower = p.brand.toLowerCase();
      if (!brandsCache.has(brandLower)) {
        await syncMutation(convex, "meta:addBrand", {
          name: p.brand,
          logo: `logo_${brandLower.replace(/\s+/g, "_")}.webp`,
          source: SOURCE_TAG,
          type: p._isAccessory ? "accessory" : p._isWatch ? "watch" : "phone",
        });
        brandsCache.add(brandLower);
        newBrands++;
      }

      if (p.model !== "Всички модели") {
        const modelKey = `${brandLower}:${p.model.toLowerCase()}`;
        if (!modelsCache.has(modelKey)) {
          await syncMutation(convex, "meta:addModel", {
            brand: p.brand,
            name: p.model,
            source: SOURCE_TAG,
            type: p._isWatch ? "watch" : "phone",
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
    const chunk = caseKingProducts
      .slice(i, i + CHUNK)
      .map(({ _isWatch, _isAccessory, _namingWarnings, ...rest }) => rest);
    const res = await syncMutation(convex, "products:upsertBatch", { products: chunk });
    totalCreated += res.createdCount || 0;
    totalUpdated += res.updatedCount || 0;
    console.log(
      `  партида ${i / CHUNK + 1}: +${res.createdCount} нови, ${res.updatedCount} обновени`
    );
  }

  console.log(`\nГотово! Общо нови: ${totalCreated}, общо обновени: ${totalUpdated}`);

  // Броячите на плочките в "Категории" са записано поле, не се смятат в
  // движение - без това извикване всички показват 0 след sync.
  await refreshCategoryCounts(convex);
}

// Guarded so this module can be imported (e.g. from tests, to exercise
// buildCaseKingProducts directly) without running the real sync - only
// runs main() when this file is executed directly as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Синхронизацията гръмна:", err);
    process.exit(1);
  });
}
