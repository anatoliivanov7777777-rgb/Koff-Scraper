// Синхронизира вече скрейпнатите koff.ro продукти директно в Convex базата
// на магазина - по същия начин, по който прави техния собствен admin
// импорт панел (виж admin.js:confirmCSVImport в техния repo).
//
// БЕЗОПАСНОСТ: пише директно в базата на магазина. От 2026-10-01 магазинът,
// който разработваме, е dev деплойментът aware-toucan-771; старият жив сайт
// (elated-butterfly-122) се пенсионира и вече НЕ е разрешена цел. По
// подразбиране работи в DRY RUN режим (нищо не се записва, само показва
// какво би направил).
//
// Употреба:
//   LIVE=true node sync-caseking.mjs                 - реален пълен sync
//   LIMIT=10 LIVE=true node sync-caseking.mjs         - тест с малка част
//   Cleanup is deliberately unavailable to automated synchronization.

import { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import { CATEGORY_MAP } from "./category-map.mjs";
import { parseProductName } from "./parse-names.mjs";
import { extractBrandModelsFromFullSegment, isInvalidModel } from "./brand-model.mjs";
import { calcB2BPrice, calcB2CPrice } from "./pricing.mjs";
import { buildKoffImages } from "./image-urls.mjs";
import { resolvePublicMaker } from "./public-maker.mjs";
import { generateProductName } from "./naming-engine.mjs";
import { pathToFileURL } from "node:url";

// Единственият деплоймент, в който този sync има право да пише. Умишлено е
// константа в кода, а не стойност, прочетена от средата: CASEKING_CONVEX_URL
// идва от GitHub secrets и може да бъде сменен без review, така че реалното
// решение коя база е позволена се взема от проверката по-долу, не от secret-а.
// Сменена е от elated-butterfly-122 на 2026-10-01, когато магазинът се мести
// върху dev деплоймента.
const OWNED_CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";
const CASEKING_CONVEX_URL = process.env.CASEKING_CONVEX_URL;
const CASEKING_SYNC_SECRET = process.env.CASEKING_SYNC_SECRET;

const LIVE = process.env.LIVE === "true";
const CLEANUP = process.env.CLEANUP === "true";
// "dry" (подразбиране) = само брои и печата; "apply" = нулира реално.
// Продуктите, които доставчикът вече не предлага, губят наличността си -
// виж reconcileFeedStock по-долу.
const STOCK_ZERO_MODE = process.env.STOCK_ZERO_MODE === "apply" ? "apply" : "dry";
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
  // The feed reconciliation (convex/koffSyncFeed.ts on the CaseKing side):
  // what the supplier no longer lists gets stock 0, so it leaves the
  // storefront. Two reads, two writes, all four secret-gated.
  "koffSyncFeed:pageSyncedProducts",
  "koffSyncFeed:zeroStockNotInFeed",
  "koffSyncFeed:recordSyncRun",
  "koffSyncFeed:previousRun",
]);
function assertSyncOperation(operation) {
  if (!SYNC_OPERATIONS.has(operation)) throw new Error("Operation is not approved for machine sync");
}
function syncMutation(convex, operation, args) {
  assertSyncOperation(operation);
  return convex.mutation(operation, { ...args, syncSecret: CASEKING_SYNC_SECRET });
}
function syncQueryCall(convex, operation, args) {
  assertSyncOperation(operation);
  return convex.query(operation, { ...args, syncSecret: CASEKING_SYNC_SECRET });
}
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

// Категории, в които филтърът е по марка на САМИЯ аксесоар (Mcdodo,
// Baseus, Spigen...), а НЕ по съвместим телефон. Зарядно или кабел не
// "принадлежи" на конкретен модел телефон, затова тук не разцепваме
// продукта на по един ред за всяко съвместимо устройство - качва се
// ЕДИН ред с марка = производителя.
const ACCESSORY_CATEGORY_SLUGS = new Set([
  "zaryadni-ustroystva",
  "kabeli-za-zaryadane",
  "bezzhichni-zaryadni",
  "vanshni-baterii",
  "headphones",
  "memory_cards",
  "audio_cables",
  "postavki-za-byuro",
  "selfi-stikove",
  "popsoket-i-vrazki",
  "aksesoari-za-avtomobili",
]);

// koff.ro пише имената на производителите непоследователно (МCDODO,
// mcdodo, McDodo...). Уеднаквяваме ги, за да не се появят по 3 отделни
// марки в дропдауна за едно и също нещо. Сравнението е без регистър;
// ако марка липсва тук, се ползва както е дошла от доставчика.
const ACCESSORY_BRAND_CANONICAL = {
  mcdodo: "Mcdodo",
  baseus: "Baseus",
  spigen: "Spigen",
  hoco: "Hoco",
  remax: "Remax",
  borofone: "Borofone",
  ugreen: "Ugreen",
  anker: "Anker",
  joyroom: "Joyroom",
  usams: "Usams",
  dudao: "Dudao",
  xo: "XO",
  wiwu: "WiWU",
  nillkin: "Nillkin",
  ldnio: "LDNIO",
  samsung: "Samsung",
  apple: "Apple",
  xiaomi: "Xiaomi",
  huawei: "Huawei",
  sandisk: "SanDisk",
  kingston: "Kingston",
  lexar: "Lexar",
  jbl: "JBL",
  sony: "Sony",
};

function normalizeAccessoryBrand(name) {
  const n = norm(name);
  if (!n) return "";
  return ACCESSORY_BRAND_CANONICAL[n.toLowerCase()] || n;
}

// koff.ro дава цените БЕЗ ДДС. Надценките се начисляват върху база с
// включено ДДС, затова умножаваме преди да извикаме pricing.mjs -
// границите (0.60-8 лв за B2B, 2-12 лв за B2C) остават непроменени.
const VAT_RATE = 0.20;
const VAT_MULTIPLIER = 1 + VAT_RATE;

// Koff не дава структурирани material/weight/origin/delivery данни за
// всеки продукт - празен низ означава "непознато", НЕ фабрикуван факт.
// Никога не замествай с генерично "Не е посочено"/"Внос"/"Високо
// качество" и т.н. - това би било също толкова невярно, колкото
// оригиналните фабрикувани стойности.
const DEFAULT_SPECS = {
  material: "",
  weight: "",
  origin: "",
  delivery: "",
};

function norm(s) {
  return (s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

// Допълнения към CATEGORY_MAP - koff.ro категории, които липсваха и
// заради които секции на сайта стояха празни. Държим ги тук, за да не
// пипаме category-map.mjs; може после да се слеят в него.
// ВАЖНО: ключовете са ТОЧНИТЕ имена от koff.ro (както излизат в
// диагностиката "НЕПОКРИТИ категории").
const EXTRA_CATEGORY_MAP = {
  // --- Слушалки ---
  "In-Ear Wireless": "headphones",
  "On-Ear": "headphones",
  "Erabuds Mix": "headphones",
  "Bluetooth Headset": "headphones",
  "Over the Neck": "headphones",
  Airpods: "headphones",
  "Galaxy Buds": "headphones",

  // --- Памети & Карти ---
  "Memory sticks": "memory_cards",
  "Memory cards": "memory_cards",
  "Memory & Storage Devices": "memory_cards",
  "Card readers": "memory_cards",
  "Solid-State Drive (SSD)": "memory_cards",

  // --- Аудио кабели ---
  "Audio-Video Adapters": "audio_cables",
  "Jack 3.5mm": "audio_cables",

  // --- Кабели за зареждане (адаптери/преходници) ---
  "OTG Adapters": "kabeli-za-zaryadane",
  "USB/Type-C/Lightning Adapters": "kabeli-za-zaryadane",

  // --- Дребни поправки ---
  "Phone Cases": "keysove-i-kalufi",
};

// Хидрогел фолиото не е отделна категория в koff.ro - стои вътре в
// протекторите за екран. Разпознаваме го по името на продукта.
const HYDROGEL_RE = /hydrogel|хидрогел/i;
const HYDROGEL_SLUG = "hydrogel_film";

// Exported (export-only change, no logic modified) so the Phase E
// read-only analysis tool can reuse the exact real category-resolution
// behavior instead of duplicating it - see
// test/sync-caseking-exports.test.mjs for a behavior-unchanged check.
export function resolveCategorySlug(rawProduct) {
  const koffCat = norm(rawProduct.category);
  const slug = CATEGORY_MAP[koffCat] || EXTRA_CATEGORY_MAP[koffCat];
  if (!slug) return null;
  if (slug === "protektori-za-ekran" && HYDROGEL_RE.test(rawProduct.name || "")) {
    return HYDROGEL_SLUG;
  }
  return slug;
}

// Сглобява storefront DISPLAY етикета "марка + модел" за компатибилното
// устройство. Изцяло presentation-layer: НЕ променя стойностите, които
// се пазят (bm.brand/bm.model, използвани от sourceKey) - само низа,
// подаван на naming-engine.mjs като deviceModel. Правила (Phase E2, въз
// основа на реални данни от пълния каталог):
//
// - Apple (не часовник): моделът сам по себе си е разпознаваем
//   (iPhone/iPad/MacBook/AirPods) - марката не се добавя ("iPhone 16 Pro
//   Max", не "Apple iPhone 16 Pro Max").
// - Samsung (не часовник): реалният текст на модела понякога вече
//   съдържа "Galaxy" (Z Fold/Flip), понякога не ("S25 Ultra") - винаги
//   показва "Samsung Galaxy ..." точно веднъж, никога дублирано.
// - MOTO: съхраняваната марка идентичност остава "MOTO" (непроменена
//   тук) - само display показва истинското име "Motorola Moto ...".
// - Всяка "<X> Watch" марка (Apple Watch, Samsung Watch, Google Watch,
//   Xiaomi Watch, Huawei Watch, Honor Watch): старата логика махаше
//   дублирана дума САМО ако е точно в началото на модела И следвана от
//   интервал - пропускаше "Watch9" (без интервал преди цифрата) и
//   "Pixel Watch 5 45mm" (думата "Watch" не е в началото). Сега маха
//   думата "Watch" от марката винаги когато моделът я споменава ГДЕ да е.
// Exported (export-only, same pattern as resolveCategorySlug) so
// test/sync-caseking-device-labels.test.mjs can verify each rule
// directly without reconstructing full raw-product fixtures.
export function deviceLabel(brand, model) {
  const trimmedBrand = brand.trim();
  const trimmedModel = model.trim();

  if (trimmedBrand === "Apple") {
    return trimmedModel;
  }

  if (trimmedBrand === "Samsung") {
    const withoutLeadingGalaxy = trimmedModel.replace(/^Galaxy\s+/i, "");
    return `Samsung Galaxy ${withoutLeadingGalaxy}`.replace(/\s+/g, " ").trim();
  }

  if (trimmedBrand === "MOTO") {
    const withoutLeadingMoto = trimmedModel.replace(/^Moto\s+/i, "");
    return `Motorola Moto ${withoutLeadingMoto}`.replace(/\s+/g, " ").trim();
  }

  if (/\bWatch$/i.test(trimmedBrand)) {
    const brandRoot = trimmedBrand.replace(/\s*Watch$/i, "").trim();
    const modelAlreadyMentionsWatch = /watch/i.test(trimmedModel);
    const label = modelAlreadyMentionsWatch
      ? `${brandRoot} ${trimmedModel}`
      : `${brandRoot} Watch ${trimmedModel}`;
    return label.replace(/\s+/g, " ").trim();
  }

  // Всички други марки - непроменено предишно поведение.
  const brandWords = trimmedBrand.split(/\s+/);
  const lastWord = brandWords[brandWords.length - 1];
  const dupRe = new RegExp(`^${lastWord}\\s+`, "i");
  const cleanModel = dupRe.test(trimmedModel)
    ? trimmedModel.replace(dupRe, "")
    : trimmedModel;
  return `${trimmedBrand} ${cleanModel}`.replace(/\s+/g, " ").trim();
}

// A generated row counts as sellable only when the supplier actually
// reported a usable positive quantity. Stock is omitted entirely from a
// generated row when Koff returned nothing verifiable (see commonFields
// below), so "missing" and "zero" both land here as NOT sellable - the
// same test the CaseKing-side availability guard in products:upsertBatch
// applies before creating a brand-new product.
export function isSellable(row) {
  return Number.isFinite(row?.stock) && row.stock > 0;
}

export function buildCaseKingProducts(raw, categorySlug) {
  const parsed = parseProductName(raw.name || "", raw.manufacturer);
  const color = parsed.color;

  // See public-maker.mjs for the Techsuit precedence rules - manufacturer
  // is authoritative, the raw-name leading token is only a fallback when
  // manufacturer is missing/empty, and nothing here ever scans for
  // "Techsuit" mid-string.
  const makerResolution = resolvePublicMaker({ manufacturer: raw.manufacturer, rawName: raw.name });

  // The public product `name` is now the naming engine's deterministic
  // Bulgarian SEO output, never the raw supplier title - see the
  // generateProductName() calls below. The real koff.ro category name it
  // needs for structured type classification is raw.category itself -
  // the same field resolveCategorySlug already reads.
  const sourceCategoryName = raw.category;

  const base = raw.basePrice * VAT_MULTIPLIER;
  const priceB2B = calcB2BPrice(base);
  const priceB2C = calcB2CPrice(base);

  // Пази реалното описание на доставчика, ако има такова - никога не
  // фабрикува промоционален текст, когато Koff не е върнал описание.
  const description = (raw.description && raw.description.trim()) || "";

  // Ако Koff не върне валидна снимка (cover) в този run (временна грешка/
  // празен отговор), НЕ пращаме image изобщо - upsertBatch пази старата
  // стойност на продукта непроменена вместо да я трие с празна/placeholder.
  const koffImages = buildKoffImages(raw);
  // `images` (пълната галерия) се праща КЪМ CaseKing само когато Koff
  // ДЕЙСТВИТЕЛНО е потвърдил успешно тази галерия в този run - т.е.
  // scrape.mjs изрично е задал raw.images (виж коментара там), а не просто
  // защото имаме валиден cover. Ако извличането на галерията се провали
  // този run, raw.images липсва и тук НЕ пращаме `images` изобщо - иначе
  // щяхме да презапишем вече съществуваща многоснимкова галерия само с
  // корицата заради временна грешка при извличането ѝ. Успешна галерия с
  // точно едно изображение (дори самата корица) си остава меродавна и
  // легитимно обновява съществуващата галерия.
  const gallerySucceeded = Array.isArray(raw.images);
  const commonFields = {
    id: null,
    // The supplier's own raw title, sent alongside `name` rather than instead
    // of it. `name` stays the naming engine's proposal, which is now only a
    // DRAFT: CaseKing decides the published name server-side from this raw
    // title (its family rules), and keeps this value as nameEn so English
    // search still finds the product.
    //
    // Convex reads it on the INSERT path only, so an existing product is never
    // re-stamped with it. Omitted when Koff returned no title at all, which
    // CaseKing treats as "a product nobody can name yet" and holds for review.
    ...(raw.name ? { supplierName: raw.name } : {}),
    ...(koffImages.length > 0 ? { image: koffImages[0] } : {}),
    ...(gallerySucceeded && koffImages.length > 0 ? { images: koffImages } : {}),
    rating: 5,
    tag: null,
    description,
    specs: DEFAULT_SPECS,
    priceB2C,
    oldPriceB2C: null,
    priceB2B,
    oldPriceB2B: null,
    source: SOURCE_TAG,
    ...(Number.isFinite(raw.stock) && raw.stock >= 0 ? { stock: raw.stock } : {}),
    // Koff's actual cart API product identifier (see product-mapping.mjs) -
    // independent of sourceId/sourceKey, which stay SKU-based for stable
    // sync identity. Omitted (not just left undefined) when invalid/absent,
    // matching the image preserve-on-omit pattern in upsertBatch.
    ...(Number.isInteger(raw.sourceProductId) && raw.sourceProductId > 0
      ? { sourceProductId: raw.sourceProductId } : {}),
  };

  // Аксесоарни категории: един ред, марка = производителят на аксесоара.
  // Съвместимите телефони НЕ се изброяват - нито като отделни редове,
  // нито в името (клиентът избира Зарядни > Mcdodo, не Зарядни > iPhone).
  if (ACCESSORY_CATEGORY_SLUGS.has(categorySlug)) {
    // accBrand is the ORIGINAL/unrebranded supplier accessory-brand
    // identity (already casing-canonicalized, e.g. "mcdodo" -> "Mcdodo")
    // - sourceKey below MUST keep using it exactly as before, never the
    // rebranded public value, or an existing Techsuit accessory row
    // would stop matching on the next sync and get duplicated instead
    // of updated.
    const accBrand = normalizeAccessoryBrand(raw.manufacturer);
    const publicAccessoryMaker = makerResolution.rebranded ? "CaseKing" : (accBrand || undefined);
    // No device-compatibility clause for accessory rows - they aren't
    // sold "for" a specific phone model (see the comment above this
    // branch), so deviceModel is intentionally omitted from this call.
    const nameResult = generateProductName({
      categorySlug,
      sourceCategoryName,
      publicMaker: publicAccessoryMaker,
      productLine: parsed.productLine,
      color,
    });
    return [
      {
        ...commonFields,
        category: categorySlug,
        name: nameResult.name,
        brand: makerResolution.rebranded ? "CaseKing" : (accBrand || "Всички марки"),
        model: "Всички модели",
        sourceKey: `${SOURCE_TAG}:${raw.sourceId}:${categorySlug}:${accBrand || "all"}:all`,
        ...(publicAccessoryMaker !== undefined ? { publicMaker: publicAccessoryMaker } : {}),
        // локален флаг - определя type на марката при създаването ѝ
        _isAccessory: Boolean(accBrand),
        // local-only diagnostics for the Phase E dry-run report - never
        // sent to Convex, stripped alongside _isWatch/_isAccessory below.
        _namingWarnings: nameResult.warnings,
      },
    ];
  }

  let brandModels = [];
  if (parsed.rawModelSegment) {
    brandModels = extractBrandModelsFromFullSegment(parsed.rawModelSegment).filter(
      (bm) => bm.brand && bm.model && !isInvalidModel(bm.model)
    );
  }

  if (brandModels.length === 0) {
    // No verified device was resolved - never fabricate a "за ..."
    // clause or generic "universal"/"for all phones" wording (see
    // buildDeviceClause in naming-engine.mjs: omitting deviceModel here
    // already guarantees no such clause is added).
    const nameResult = generateProductName({
      categorySlug,
      sourceCategoryName,
      publicMaker: makerResolution.publicMaker,
      productLine: parsed.productLine,
      color,
    });
    return [
      {
        ...commonFields,
        category: categorySlug,
        name: nameResult.name,
        brand: "Всички марки",
        model: "Всички модели",
        sourceKey: `${SOURCE_TAG}:${raw.sourceId}:${categorySlug}:all:all`,
        ...(makerResolution.publicMaker !== undefined ? { publicMaker: makerResolution.publicMaker } : {}),
        _namingWarnings: nameResult.warnings,
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

  return unique.map((bm) => {
    // Reuses the existing, already-verified compatibility label exactly
    // as before (see deviceLabel above) - no new device/model parser is
    // introduced in this phase.
    const resolvedDeviceLabel = deviceLabel(bm.brand, bm.model);
    // IMPORTANT: naming TYPE classification always uses the ORIGINAL
    // categorySlug (e.g. keysove-i-kalufi), even for a row whose STORED
    // category becomes the watch slug below - a phone/watch case must
    // still be named "Калъф ... за <watch>", not a generic watch
    // "Аксесоар ...". Only the stored `category`/sourceKey use the
    // watch-remapped slug, exactly as before.
    const nameResult = generateProductName({
      categorySlug,
      sourceCategoryName,
      publicMaker: makerResolution.publicMaker,
      productLine: parsed.productLine,
      deviceModel: resolvedDeviceLabel,
      color,
    });
    return {
      ...commonFields,
      category: bm.isWatch ? WATCH_CATEGORY_SLUG : categorySlug,
      name: nameResult.name,
      // brand/model stay the COMPATIBLE-DEVICE identity (e.g. Apple/iPhone
      // 16 Pro Max) - unaffected by any manufacturer rebrand, exactly as
      // before. sourceKey below is built from the same device brand/model,
      // never from makerResolution's public value.
      brand: bm.brand,
      model: bm.model,
      sourceKey: `${SOURCE_TAG}:${raw.sourceId}:${bm.isWatch ? WATCH_CATEGORY_SLUG : categorySlug}:${bm.brand}:${bm.model}`,
      ...(makerResolution.publicMaker !== undefined ? { publicMaker: makerResolution.publicMaker } : {}),
      // не се праща към Convex - ползва се само локално, за да знаем какъв
      // type да зададем на марката/модела при създаването им
      _isWatch: bm.isWatch,
      _namingWarnings: nameResult.warnings,
    };
  });
}

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

// ---------------------------------------------------------------------------
// СТЪПКА G5 1a: продуктите, които доставчикът вече не предлага, губят наличност
// ---------------------------------------------------------------------------
// Инструкцията на собственика (2026-10-01): "Продукти, които не са в
// наличност задължително трябва да се махат от сайта." Sync-ът обновява само
// редовете, които СА в feed-а - продукт, който доставчикът е спрял, не
// присъства в payload-а и нищо не го пипа. Тази стъпка затваря другата
// половина: всеки ред със source "koff-sync", чийто sourceKey не е в feed-а
// на ТОЗИ run, получава stock: 0 (само stock - виж koffSyncFeed.ts).
//
//   STOCK_ZERO_MODE=dry    (подразбиране) - брои и печата, не пише
//   STOCK_ZERO_MODE=apply                 - нулира реално, партиди по 200
//
// Предпазител: ако feed-ът на този run е под 90% от последния успешен run,
// стъпката се прескача изцяло и се отчита - счупено или частично сваляне
// никога не бива да изпразва магазина. Редове без sourceKey никога не се
// пипат; те се отчитат отделно, за да ги види човек.
const FEED_DROP_RATIO = 0.9;
const STOCK_ZERO_CHUNK = 200;

// Чиста функция - тества се директно (test/sync-caseking-feed-stock.test.mjs).
// Връща кои редове подлежат на нулиране и кои са отказани и защо.
export function feedStockChanges(syncedProducts, feedKeys) {
  const toZero = [];
  const missingSourceKey = [];
  let alreadyZero = 0;
  for (const p of syncedProducts) {
    // Ред без стабилна доставчикова идентичност не може да се провери срещу
    // feed-а. Отказваме се и го отчитаме - никога не гадаем.
    if (typeof p.sourceKey !== "string" || p.sourceKey === "") {
      missingSourceKey.push(p.productId);
      continue;
    }
    if (feedKeys.has(p.sourceKey)) continue;
    // Вече е нула - няма какво да се пише (идемпотентност).
    if (p.stock === 0) {
      alreadyZero += 1;
      continue;
    }
    toZero.push({ productId: p.productId, expectedSourceKey: p.sourceKey });
  }
  return { toZero, missingSourceKey, alreadyZero };
}

// Чиста функция: по-малко от 90% от предишния успешен run = съмнителен спад.
// Без база (първи run) не се задейства - предпазителят пази от СПАД, а
// MIN_RAW проверката по-горе вече пази от грубо счупено сваляне.
export function isFeedDrop(currentKeys, previousKeys) {
  if (!Number.isFinite(previousKeys) || previousKeys <= 0) return false;
  return currentKeys < previousKeys * FEED_DROP_RATIO;
}

async function reconcileFeedStock(convex, caseKingProducts, runMeta) {
  console.log("\n--- Стъпка G5 1a: продукти извън feed-а (stock 0) ---");
  const run = { ...runMeta, finishedAt: new Date().toISOString() };

  const feedKeys = new Set();
  for (const p of caseKingProducts) {
    if (typeof p.sourceKey === "string" && p.sourceKey !== "") feedKeys.add(p.sourceKey);
  }

  // Тестов run с LIMIT не бива да пипа нищо: feed-ът е само първите N
  // продукта и всичко останало изглежда "извън feed-а".
  if (LIMIT) {
    console.log(`  ПРЕСКОЧЕНО: тестов run с LIMIT=${LIMIT} (feed-ът е частичен).`);
    return null;
  }

  const previous = await syncQueryCall(convex, "koffSyncFeed:previousRun", {});
  // previousRun връща последния run, минал предпазителя. Ако ВСЕКИ записан досега
  // run е бил спад, връща последния такъв - и тогава също се прескача, вместо
  // спадът да се приеме за база.
  const previousWasDrop = previous?.stockZeroMode === "skipped-feed-drop";
  if (previous && (previousWasDrop || isFeedDrop(feedKeys.size, previous.feedKeys))) {
    const detail = previousWasDrop
      ? `нито един записан run не е минал предпазителя (последен: ${previous.feedKeys} ключа, ${previous.startedAt})`
      : `feed-ът е ${feedKeys.size} ключа = ` +
        `${((feedKeys.size / previous.feedKeys) * 100).toFixed(1)}% от последния минал предпазителя run ` +
        `(${previous.feedKeys}, ${previous.startedAt})`;
    console.log(
      `  ⛔ ПРЕСКОЧЕНО: ${detail}. Счупено или частично сваляне не бива да ` +
        `изпразва магазина - нищо не е пипано.`
    );
    await syncMutation(convex, "koffSyncFeed:recordSyncRun", {
      run: { ...run, feedKeys: feedKeys.size, notInFeed: 0, zeroed: 0, stockZeroMode: "skipped-feed-drop" },
    });
    return { feedKeys: feedKeys.size, notInFeed: 0, zeroed: 0, skipped: true };
  }
  if (!previous) console.log("  (няма предишен успешен run - предпазителят за спад не се прилага)");

  // Четем всички редове на sync-а (само id/sourceKey/stock) и изчисляваме
  // разликата локално - feed-ът е в този процес, не в базата.
  const synced = [];
  let cursor = null;
  for (;;) {
    const page = await syncQueryCall(convex, "koffSyncFeed:pageSyncedProducts", { cursor, pageSize: 1000 });
    synced.push(...page.products);
    cursor = page.continueCursor;
    if (page.isDone) break;
  }
  const { toZero, missingSourceKey, alreadyZero } = feedStockChanges(synced, feedKeys);
  // Редовете, които чакат човек в "За преглед" - за отчета на run-а (те и без
  // това не се показват в сайта, докато не бъдат именувани).
  const pendingReview = synced.filter((p) => p.reviewStatus === "pending").length;
  console.log(
    `  Синхронизирани редове: ${synced.length}; извън feed-а за нулиране: ${toZero.length}; ` +
      `вече с 0: ${alreadyZero}; без sourceKey (не се пипат): ${missingSourceKey.length}; ` +
      `в "За преглед": ${pendingReview}`
  );

  const dryRun = STOCK_ZERO_MODE !== "apply";
  let zeroed = 0;
  let wouldZero = 0;
  const skipReasons = new Map();
  for (let i = 0; i < toZero.length; i += STOCK_ZERO_CHUNK) {
    const res = await syncMutation(convex, "koffSyncFeed:zeroStockNotInFeed", {
      rows: toZero.slice(i, i + STOCK_ZERO_CHUNK),
      dryRun,
    });
    zeroed += res.zeroed;
    wouldZero += res.wouldZero;
    for (const s of res.skipped) skipReasons.set(s.reason, (skipReasons.get(s.reason) || 0) + 1);
  }

  if (dryRun) {
    console.log(
      `  DRY RUN: ${wouldZero} продукта БИХА получили stock 0. Няма запис - ` +
        `за реален запис пусни с STOCK_ZERO_MODE=apply.`
    );
  } else {
    console.log(`  APPLY: ${zeroed} продукта получиха stock 0.`);
  }
  for (const [reason, n] of skipReasons) console.log(`  отказани (${reason}): ${n}`);

  await syncMutation(convex, "koffSyncFeed:recordSyncRun", {
    run: {
      ...run,
      feedKeys: feedKeys.size,
      notInFeed: toZero.length,
      zeroed: dryRun ? 0 : zeroed,
      stockZeroMode: dryRun ? "dry" : "applied",
    },
  });
  return {
    feedKeys: feedKeys.size,
    notInFeed: toZero.length,
    zeroed: dryRun ? 0 : zeroed,
    wouldZero,
    alreadyZero,
    missingSourceKey: missingSourceKey.length,
    pendingReview,
    mode: STOCK_ZERO_MODE,
    skipped: false,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`Режим: ${LIVE ? "LIVE" : "DRY RUN (само преглед)"}`);

  if (LIMIT) console.log(`Лимит за тест: първите ${LIMIT} суровини продукта`);
  if (LIVE) {
    console.log(
      `Стъпка G5 1a (продукти извън feed-а): ${STOCK_ZERO_MODE === "apply" ? "APPLY" : "DRY RUN"}`
    );
  }

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

  // Последна стъпка, и само след успешен запис: продукт, който доставчикът
  // вече не предлага, напуска сайта (виж коментара при reconcileFeedStock).
  await reconcileFeedStock(convex, caseKingProducts, {
    startedAt,
    rawProducts: rawProducts.length,
    created: totalCreated,
    updated: totalUpdated,
  });
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
