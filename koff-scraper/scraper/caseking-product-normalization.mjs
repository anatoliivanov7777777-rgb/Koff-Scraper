// ============================================================================
// CASEKING PRODUCT NORMALIZATION — PURE, SIDE-EFFECT FREE
// ----------------------------------------------------------------------------
// Extracted verbatim from sync-caseking.mjs (lines 56-443 at extraction time).
//
// WHY THIS MODULE EXISTS
// sync-caseking.mjs carries a top-level production-target guard: it throws on
// import unless CASEKING_CONVEX_URL points at the owned production deployment.
// That guard is correct and is NOT being weakened. But it also meant the pure
// normalization logic could not be reused offline, so no staging dry-run could
// ever be derived without a full network scrape.
//
// Importing this module must never:
//   - read process.env
//   - perform a network call
//   - check a deployment target
//   - mutate anything
//   - touch the filesystem
//
// Production sync (sync-caseking.mjs) imports these SAME functions, so there is
// exactly one implementation of identity, pricing and naming - see
// test/normalization-parity.test.mjs, which proves the output is unchanged.
// ============================================================================

import { CATEGORY_MAP } from "./category-map.mjs";
import { parseProductName } from "./parse-names.mjs";
import { extractBrandModelsFromFullSegment, isInvalidModel } from "./brand-model.mjs";
import { addVat, calcB2BPrice, calcB2CPrice } from "./pricing.mjs";
import { buildKoffImages } from "./image-urls.mjs";
import { resolvePublicMaker } from "./public-maker.mjs";
import { generateProductName } from "./naming-engine.mjs";

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
// включено ДДС. Използваме общия pricing helper, за да няма разминаване
// между реалния CaseKing sync и Excel/export пътя.

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

// Category audit (owner, 2026-10-12): some Koff categories hold products that
// belong on another CaseKing shelf - watch screen protectors among phone
// protectors, phone cases among watch accessories, Guess phone cases with a
// strap among straps, MagSafe wallets among desk stands, AirPods cases among
// phone cases. This decides the STORED category from the supplier's own
// title. It never feeds sourceKey: a product's key keeps the mapped slug, so
// an existing row is still found by the sync (which never re-asserts the
// category of an existing row anyway) and nothing is duplicated.
const WATCH_DEVICE_RE = /\b(watch|garmin|fenix|forerunner|instinct|epix|venu|vivoactive|amazfit|fitbit)\b|часовник/i;
const ACTION_CAM_RE = /\b(gopro|insta360|dji)\b/i;
const CAR_SCREEN_RE = /\btesla\b/i;
const CLEANING_RE = /\b(cleaning|carewipe|wipes?|microfib(er|re))\b|почистващ|кърпа за почистване/i;
const EARBUDS_RE = /\b(airpods|galaxy buds|earbuds)\b/i;
const PHONE_DEVICE_RE = /\b(iphone|galaxy [sazmn]\d|galaxy z|pixel \d|redmi|xiaomi \d|honor \d|oppo|realme|motorola|moto [geg])/i;
const PHONE_CASE_CODE_RE = /\b(GUH[CM]P|KLH[CM]P)|\bhard ?case\b|\bcase\b/i;
const EARBUD_CASE_SLUG = "kalafi-za-slushalki";
const EARBUD_CASE_RE = /\b(case|cover|silicone|hardcase)\b|калъф|кейс/i;
const EARPHONES_WITH_CASE_RE = /\b(earbuds?|headphones?|headset|tws|bluetooth v?\d|anc|enc)\b|слушалки с/i;
const WALLET_RE = /\b(wallet|card ?holder)\b|портфейл/i;

export function refineCategorySlug(categorySlug, rawProduct) {
  const title = norm(rawProduct && rawProduct.name);
  if (!categorySlug || !title) return categorySlug;
  switch (categorySlug) {
    case "protektori-za-ekran":
      if (CLEANING_RE.test(title) && !/glass|protector|tempered|стъкл|протектор/i.test(title)) return "drugi";
      if (WATCH_DEVICE_RE.test(title)) return WATCH_CATEGORY_SLUG;
      if (ACTION_CAM_RE.test(title)) return "selfi-stikove";
      if (CAR_SCREEN_RE.test(title)) return "aksesoari-za-avtomobili";
      return categorySlug;
    case WATCH_CATEGORY_SLUG:
      if (WATCH_DEVICE_RE.test(title)) return categorySlug;
      if (EARBUDS_RE.test(title)) return EARBUD_CASE_SLUG;
      if (PHONE_DEVICE_RE.test(title)) return "keysove-i-kalufi";
      return categorySlug;
    case "keysove-i-kalufi":
      if (EARBUDS_RE.test(title) && !PHONE_DEVICE_RE.test(title)) return EARBUD_CASE_SLUG;
      return categorySlug;
    case "headphones":
      // A case FOR earphones, not the earphones themselves (2026-10-13: the
      // shop has its own "Калъфи за слушалки" shelf since the PhonePlay import).
      if (EARBUD_CASE_RE.test(title) && !EARPHONES_WITH_CASE_RE.test(title)) return EARBUD_CASE_SLUG;
      return categorySlug;
    case "popsoket-i-vrazki":
      if (/^(guess|karl lagerfeld)\b/i.test(title) && PHONE_CASE_CODE_RE.test(title)) return "keysove-i-kalufi";
      return categorySlug;
    case "postavki-za-byuro":
      if (WALLET_RE.test(title)) return "popsoket-i-vrazki";
      return categorySlug;
    default:
      return categorySlug;
  }
}

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

  const base = addVat(raw.basePrice);
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
        category: refineCategorySlug(categorySlug, raw),
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
        category: refineCategorySlug(categorySlug, raw),
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
      category: refineCategorySlug(bm.isWatch ? WATCH_CATEGORY_SLUG : categorySlug, raw),
      name: nameResult.name,
      // brand/model stay the COMPATIBLE-DEVICE identity (e.g. Apple/iPhone
      // 16 Pro Max) - unaffected by any manufacturer rebrand, exactly as
      // before. sourceKey below is built from the same device brand/model,
      // never from makerResolution's public value.
      brand: bm.brand,
      model: bm.model,
      // bm.sourceModel: the spelling before the family canonicalization
      // (brand-model.mjs canonicalizeFamilyModel), so an existing product's
      // key - and so the product itself - stays the same when only the
      // displayed model name is corrected.
      sourceKey: `${SOURCE_TAG}:${raw.sourceId}:${bm.isWatch ? WATCH_CATEGORY_SLUG : categorySlug}:${bm.brand}:${bm.sourceModel ?? bm.model}`,
      ...(makerResolution.publicMaker !== undefined ? { publicMaker: makerResolution.publicMaker } : {}),
      // не се праща към Convex - ползва се само локално, за да знаем какъв
      // type да зададем на марката/модела при създаването им
      _isWatch: bm.isWatch,
      _namingWarnings: nameResult.warnings,
    };
  });
}

// Re-exported so sync-caseking.mjs's main() imports one name set from here.
export { SOURCE_TAG, WATCH_CATEGORY_SLUG, ACCESSORY_CATEGORY_SLUGS, ACCESSORY_BRAND_CANONICAL, DEFAULT_SPECS, norm, EXTRA_CATEGORY_MAP };
