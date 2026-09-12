// Чист, детерминиран генератор на български storefront имена на продукти.
//
// НАМЕРЕНО ИЗОЛИРАН от всичко специфично за доставчика/фулфилмънта:
// engine-ът НЕ знае нищо за sourceKey, sourceProductId, Koff количката,
// нито за правилото Techsuit -> CaseKing (кой е "публичният производител"
// вече е РЕШЕНО от извикващия код и идва готово като publicMaker). Тази
// изолация е нарочна - engine-ът е чисто текстово форматиране, тествано
// самостоятелно, без странични ефекти и без мрежа/база данни.
//
// ПЪРВА ВЕРСИЯ: НЕ прави агресивен парсинг/извличане на watt/дължина на
// кабел/капацитет на батерия и т.н. от свободен текст - каквото вече го
// има в productLine, се пази непроменено (lossless за продуктовата линия).

import { normalizeColor } from "./color-map.mjs";

// categorySlug -> базов български тип продукт. Използва се като ПЪРВИЧЕН,
// структуриран класификатор (вместо да се гадае от свободен текст на
// името) - вижте sync-caseking.mjs/category-map.mjs за произхода на слъга.
const PRODUCT_TYPE_MAP = {
  "keysove-i-kalufi": "Калъф",
  "protektori-za-ekran": "Протектор за екран",
  "zaryadni-ustroystva": "Зарядно",
  "bezzhichni-zaryadni": "Безжично зарядно",
  "kabeli-za-zaryadane": "Кабел",
  "vanshni-baterii": "Външна батерия",
  "postavki-za-byuro": "Стойка",
  "headphones": "Слушалки",
  "aksesoari_chasovnici": "Аксесоар",
  // hydrogel_film is already disambiguated by sync-caseking.mjs's
  // resolveCategorySlug (it only assigns this slug when the name matches
  // HYDROGEL_RE within protektori-za-ekran) - unambiguous by the time it
  // reaches this classifier, no sourceCategoryName refinement needed.
  "hydrogel_film": "Хидрогел фолио",
  // selfi-stikove has exactly one real koff.ro category mapped to it
  // ("Selfie / Vlogging", see category-map.mjs) - unambiguous.
  "selfi-stikove": "Аксесоар за селфи",
};

// Генеричен, безопасен fallback тип, ползван когато categorySlug липсва,
// е непознат, или е "чадърна" категория без точно разпознат
// sourceCategoryName - никога не се гадае по свободен текст на името.
const FALLBACK_PRODUCT_TYPE = "Аксесоар";

// protektori-za-ekran обединява екранни И камерови протектори под един
// слъг (виж category-map.mjs) - разграничението се пази само в точното
// (allow-listed) име на koff.ro категорията, преди да колабира в слъга.
// Точните низове по-долу са реални стойности от category-map.mjs.
const CAMERA_SOURCE_CATEGORIES = new Set([
  "camera glass",
  "full camera glass",
  "lens protection",
  "lens protector",
  "camera lens protector",
  "armorite camera lens protectors",
  "optik.tr camera glass",
  "camera protector",
  "lens protector tempered glass",
]);

// aksesoari-za-avtomobili също е "чадърна" - разграничение само чрез
// точно (allow-listed) име на koff.ro категорията. Реални стойности от
// category-map.mjs.
const CAR_SOURCE_CATEGORY_TYPES = new Map([
  ["car chargers", "Зарядно за кола"],
  ["car holders", "Стойка за кола"],
  ["car holders with wireless charging", "Стойка с безжично зареждане за кола"],
]);
// По-специфичен safe fallback за тази категория, отколкото генеричното
// "Аксесоар" - все още не измисля конкретен тип, но остава вярно, че е
// автомобилен аксесоар. Реални непокрити стойности: "Car Gadgets",
// "Window Scappers" (виж category-map.mjs).
const CAR_GENERIC_FALLBACK = "Автомобилен аксесоар";

// memory_cards обединява няколко различни реални koff.ro категории под
// един слъг (виж EXTRA_CATEGORY_MAP в sync-caseking.mjs) - разграничение
// само чрез точно (allow-listed) име.
const MEMORY_SOURCE_CATEGORY_TYPES = new Map([
  ["memory cards", "Карта памет"],
  ["memory sticks", "USB памет"],
  ["card readers", "Четец за карти"],
  ["solid-state drive (ssd)", "SSD"],
]);
// "Memory & Storage Devices" и всяка друга непозната стойност под този
// слъг - твърде общо, за да се твърди конкретен тип продукт.
const MEMORY_GENERIC_FALLBACK = "Устройство за съхранение";

// audio_cables също е "чадърна" - вижте EXTRA_CATEGORY_MAP.
const AUDIO_SOURCE_CATEGORY_TYPES = new Map([
  ["jack 3.5mm", "Аудио кабел"],
  ["audio-video adapters", "Аудио/видео адаптер"],
]);
const AUDIO_GENERIC_FALLBACK = "Аудио аксесоар";

// popsoket-i-vrazki - точно известните реални koff.ro категории под този
// слъг (виж category-map.mjs) са връзки/каишки за телефон; всяка друга
// непозната стойност пада на безопасния генеричен fallback вместо да се
// твърди, че е точно такъв аксесоар.
const LANYARD_SOURCE_CATEGORIES = new Set([
  "link straps",
  "lanyard strap",
  "lanyard crossbody",
]);

function normWs(value) {
  return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Проверява дали `haystack` започва с думата/фразата `needle`, без
// значение на регистъра, с истинска граница на думата отдясно (за да не
// съвпадне частично, напр. "Spi" вътре в "Spigen").
function startsWithPhrase(haystack, needle) {
  if (!haystack || !needle) return false;
  const re = new RegExp(`^${escapeRegExp(needle)}(?![a-zA-Zа-яА-Я0-9])`, "i");
  return re.test(haystack);
}

function classifyProductType(categorySlug, sourceCategoryName, warnings) {
  const slug = normWs(categorySlug);
  const sourceCat = normWs(sourceCategoryName).toLowerCase();

  if (slug === "protektori-za-ekran" && CAMERA_SOURCE_CATEGORIES.has(sourceCat)) {
    return "Протектор за камера";
  }

  if (slug === "aksesoari-za-avtomobili") {
    const refined = CAR_SOURCE_CATEGORY_TYPES.get(sourceCat);
    if (refined) return refined;
    warnings.push(
      `Ambiguous category "aksesoari-za-avtomobili" without an exact-known sourceCategoryName ("${sourceCategoryName || ""}") - using safe car-accessory fallback type`
    );
    return CAR_GENERIC_FALLBACK;
  }

  if (slug === "memory_cards") {
    const refined = MEMORY_SOURCE_CATEGORY_TYPES.get(sourceCat);
    if (refined) return refined;
    warnings.push(
      `Ambiguous category "memory_cards" without an exact-known sourceCategoryName ("${sourceCategoryName || ""}") - using safe storage-device fallback type`
    );
    return MEMORY_GENERIC_FALLBACK;
  }

  if (slug === "audio_cables") {
    const refined = AUDIO_SOURCE_CATEGORY_TYPES.get(sourceCat);
    if (refined) return refined;
    warnings.push(
      `Ambiguous category "audio_cables" without an exact-known sourceCategoryName ("${sourceCategoryName || ""}") - using safe audio-accessory fallback type`
    );
    return AUDIO_GENERIC_FALLBACK;
  }

  if (slug === "popsoket-i-vrazki") {
    if (LANYARD_SOURCE_CATEGORIES.has(sourceCat)) return "Връзка за телефон";
    warnings.push(
      `Ambiguous category "popsoket-i-vrazki" without an exact-known lanyard/strap sourceCategoryName ("${sourceCategoryName || ""}") - using safe generic fallback type`
    );
    return FALLBACK_PRODUCT_TYPE;
  }

  if (slug && PRODUCT_TYPE_MAP[slug]) {
    return PRODUCT_TYPE_MAP[slug];
  }

  warnings.push(
    `Unknown or unmapped categorySlug ("${categorySlug || ""}") - using safe generic fallback type`
  );
  return FALLBACK_PRODUCT_TYPE;
}

// Сглобява "производител + продуктова линия" сегмента, БЕЗ да дублира
// производителя, ако вече е началната дума/фраза на productLine (напр.
// publicMaker="Spigen", productLine="Spigen Rugged Armor" -> "Spigen
// Rugged Armor", не "Spigen Spigen Rugged Armor"). Продуктовата линия
// НИКОГА не се превежда/пренаписва - връща се точно както е подадена
// (само нормализирани интервали), за да остане lossless спрямо търговски
// имена (CamShield Pro, Ultra Hybrid, Cafule, MagSafe, Mix, Series...).
function buildMakerLineSegment(publicMaker, productLine) {
  const maker = normWs(publicMaker);
  const line = normWs(productLine);

  if (!maker) return line;
  if (!line) return maker;
  if (startsWithPhrase(line, maker)) return line;
  return `${maker} ${line}`;
}

// Сглобява "за [устройство]" клаузата - САМО когато е даден точен,
// вече резолвнат deviceModel (engine-ът никога не фабрикува съвместимост).
// deviceModel се използва точно както е подаден (upstream парсването,
// напр. brand-model.mjs, вече решава дали марката трябва да е част от
// него - "iPhone 16 Pro Max" вече е самодостатъчен, докато друг pipeline
// може да подаде "Samsung Galaxy S25 Ultra" с марката вътре). deviceBrand
// НИКОГА не се добавя отделно тук - точно за да не се получи дублиране
// като "Samsung Samsung Galaxy S25 Ultra", ако deviceModel вече я
// съдържа. Суфиксите на модела (Pro, Pro Max, Plus, Ultra, FE, 5G...) се
// пазят точно както са подадени.
function buildDeviceClause(deviceModel) {
  const model = normWs(deviceModel);
  if (!model) return "";
  return `за ${model}`;
}

// Превежда САМО разпознати, изолирани цветове (точно, без регистър,
// пълно съвпадение). Непознат/брандиран цвят (напр. "Space Gray") се
// ПАЗИ непреведен в изхода и генерира предупреждение - никога не се
// подвежда мълчаливо превод, нито се изхвърля мълчаливо.
function buildColorClause(rawColorInput, warnings) {
  const rawColor = normWs(rawColorInput);
  if (!rawColor) return { clause: "", normalizedColor: null };

  const translated = normalizeColor(rawColor);
  if (translated) {
    return { clause: `– ${translated}`, normalizedColor: translated };
  }

  warnings.push(`Unrecognized color "${rawColor}" preserved without translation`);
  return { clause: `– ${rawColor}`, normalizedColor: null };
}

// Генерира едно детерминирано, безопасно българско publicName от вече
// резолвнати, структурирани входни полета. Никога не мутира `input`.
//
// Структура: [Тип] [Публичен производител] [Продуктова линия]
//            [за точен модел устройство, ако е даден]
//            [– нормализиран цвят, ако е разпознат]
export function generateProductName(input = {}) {
  const warnings = [];

  // deviceBrand is accepted (per the suggested input shape) but
  // intentionally not read here - see buildDeviceClause for why it is
  // never inserted separately from deviceModel.
  const { categorySlug, sourceCategoryName, publicMaker, productLine, deviceModel, color } = input;

  const productType = classifyProductType(categorySlug, sourceCategoryName, warnings);
  const makerLineSegment = buildMakerLineSegment(publicMaker, productLine);
  const deviceClause = buildDeviceClause(deviceModel);
  const { clause: colorClause, normalizedColor } = buildColorClause(color, warnings);

  const name = normWs(
    [productType, makerLineSegment, deviceClause, colorClause].filter(Boolean).join(" ")
  );

  return { name, productType, normalizedColor, warnings };
}
