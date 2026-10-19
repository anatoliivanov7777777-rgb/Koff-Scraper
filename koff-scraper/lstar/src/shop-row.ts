// Продукт от LStar → ред за магазина (convex/lstarSync.ts:applyBatch в CaseKing).
//
// Решенията на собственика (2026-10-19):
//   - цените на LStar са с ДДС → цените в магазина са правилото на живия сайт
//     върху цената на LStar, без ×1.23 (pricing.ts);
//   - имената са по схемата на магазина:
//       [тип] [марка/серия] за [модел], [свойство] - [цвят]
//     (бекендът взима името на Koff, ако Koff продава същия код);
//   - еднакъв продукт при няколко доставчика: показва се най-евтиният наличен
//     (бекендът: EAN групи, с баркод или с кода на производителя).
// Нищо тук не измисля факти: телефон, цвят, мощност и дължина идват само от
// заглавието и таблицата „Спецификации“ на LStar.

import type { ScrapedProduct } from "./core.js";
import { priceFromLstar } from "./pricing.js";
import { classifyModel } from "./parse.js";

export const LSTAR_SOURCE_KEY_PREFIX = "lstar-sync:";
export const MODEL_LESS = "Всички модели";
export const ALL_BRANDS = "Всички марки";
/** Колко бройки показваме при „Наличен“ (LStar не дава количество; като PhonePlay). */
export const IN_STOCK_QUANTITY = 5;

export interface ShopRow {
  sourceKey: string;
  sourceProductId: number;
  supplierName: string;
  proposedName: string;
  description: string;
  supplierCategory: string;
  supplierUrl: string;
  image: string;
  images: string[];
  stock: number;
  priceB2C: number;
  priceB2B: number;
  costPrice: number;
  ean: string;
  supplierSku: string;
  publicMaker: string;
  category: string;
  brand: string;
  model: string;
  compat: { brand: string; model: string }[];
  needsModel: boolean;
}

export type BuildResult = { row: ShopRow } | { skip: string };

// ---- Производител --------------------------------------------------------------

const MAKER_CANONICAL: Record<string, string> = {
  guess: "Guess",
  karl: "Karl Lagerfeld",
  "karl lagerfeld": "Karl Lagerfeld",
  mb: "Mercedes-Benz",
  mercedes: "Mercedes-Benz",
  "mercedes-benz": "Mercedes-Benz",
  bmw: "BMW",
  samsung: "Samsung",
  apple: "Apple",
  philips: "Philips",
};

export function canonicalMaker(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (MAKER_CANONICAL[key]) return MAKER_CANONICAL[key];
  return raw.trim().replace(/\S+/g, (w) => (w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w));
}

// ---- Категория -------------------------------------------------------------------

export type Kind = "case" | "earbuds" | "charger" | "wireless-charger" | "cable" | "hdmi-cable";

export function kindOf(categoryPath: string, title: string): Kind | null {
  if (categoryPath === "496_567") return /\bTWS\b|earbuds/i.test(title) ? "earbuds" : "case";
  if (categoryPath === "496_569") return /magsafe|безжичн|wireless/i.test(title) ? "wireless-charger" : "charger";
  if (categoryPath === "496_570") return /\bhdmi\b/i.test(title) ? "hdmi-cable" : "cable";
  return null;
}

const KIND_CATEGORY: Record<Kind, string> = {
  case: "keysove-i-kalufi",
  earbuds: "headphones",
  charger: "zaryadni-ustroystva",
  "wireless-charger": "bezzhichni-zaryadni",
  cable: "kabeli-za-zaryadane",
  "hdmi-cable": "drugi",
};

const KIND_TYPE: Record<Kind, { type: string; gender: Gender }> = {
  case: { type: "Калъф", gender: "m" },
  earbuds: { type: "Слушалки", gender: "p" },
  charger: { type: "Зарядно", gender: "n" },
  "wireless-charger": { type: "Безжично зарядно", gender: "n" },
  cable: { type: "Кабел", gender: "m" },
  "hdmi-cable": { type: "Кабел", gender: "m" },
};

// ---- Телефони ---------------------------------------------------------------------

export interface Device { brand: string; model: string }

const SUFFIX = "(PRO\\s+MAX|PRO|PLUS|MAX|MINI|AIR|ULTRA|E)";

function titleCaseModelWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(pro|max|plus|mini|air|ultra|fe|lite)\b/g, (w) => w[0].toUpperCase() + w.slice(1))
    .replace(/\s+/g, " ")
    .trim();
}

function iphone(num: string, suffix: string | undefined): string {
  const s = suffix ? ` ${titleCaseModelWords(suffix)}` : "";
  // „IP17 E“ е iPhone 17e.
  if (suffix && /^e$/i.test(suffix.trim())) return `iPhone ${num}e`;
  return `iPhone ${num}${s}`;
}

/** Модел от таблицата на LStar: „iPhone 18 Pro Max“, „Galaxy S24 Plus“. */
export function deviceFromAttribute(value: string, brandHint: string): Device | null {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const ip = /^iphone\s+(\d{1,2})\s*(pro max|pro|plus|max|mini|air|e)?$/i.exec(text);
  if (ip) return { brand: "Apple", model: iphone(ip[1], ip[2]) };
  const galaxy = /^(?:samsung\s+)?(?:galaxy\s+)?([a-z]\d{1,3})\s*(ultra|plus|fe|\+)?$/i.exec(text);
  if (galaxy && (/samsung|galaxy/i.test(text) || /samsung|galaxy/i.test(brandHint))) {
    const suffix = galaxy[2] ? ` ${galaxy[2] === "+" ? "Plus" : titleCaseModelWords(galaxy[2])}` : "";
    return { brand: "Samsung", model: `${galaxy[1].toUpperCase()}${suffix}` };
  }
  return null;
}

/** Телефоните, които заглавието назовава („IP18 PRO MAX“, „IP17 / 18 PRO“, „iPhone 15 & 14 Plus“). */
export function devicesFromTitle(title: string): Device[] {
  const out: Device[] = [];
  const t = title.replace(/\s+/g, " ");
  // IP17 / 18 PRO MAX, IPHONE 17 / 18 PRO, IP18 PRO MAX, iPhone 15 & 14 Plus
  const re = new RegExp(`\\b(?:IP|IPHONE\\s*)(\\d{1,2})((?:\\s*(?:\\/|&)\\s*\\d{1,2})*)(?:\\s+${SUFFIX}\\b)?`, "gi");
  for (const m of t.matchAll(re)) {
    const suffix = m[3];
    const nums = [m[1], ...[...m[2].matchAll(/\d{1,2}/g)].map((x) => x[0])];
    for (const n of nums) out.push({ brand: "Apple", model: iphone(n, suffix) });
  }
  const galaxy = /\bGalaxy\s+([A-Z]\d{1,3})(?:\s+(Ultra|Plus|FE|\+))?/i.exec(t);
  if (galaxy) {
    const suffix = galaxy[2] ? ` ${galaxy[2] === "+" ? "Plus" : titleCaseModelWords(galaxy[2])}` : "";
    out.push({ brand: "Samsung", model: `${galaxy[1].toUpperCase()}${suffix}` });
  }
  return out;
}

export function devicesFor(p: ScrapedProduct): Device[] {
  const brandHint = p.attributes["Бранд"] ?? "";
  const fromAttr = (p.attributes["Модел Телефон"] ?? "")
    .split(",")
    .map((x) => deviceFromAttribute(x, brandHint))
    .filter((d): d is Device => d !== null);
  const seen = new Set<string>();
  const out: Device[] = [];
  for (const d of [...fromAttr, ...devicesFromTitle(p.name)]) {
    const key = `${d.brand}|${d.model.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

// ---- Цвят -------------------------------------------------------------------------

type Gender = "m" | "f" | "n" | "p";
type Forms = Record<Gender, string>;
const forms = (m: string, f: string, n: string, p: string): Forms => ({ m, f, n, p });
const fixed = (word: string): Forms => ({ m: word, f: word, n: word, p: word });

// Най-дългите първи: „LIGHT BLUE“ преди „BLUE“.
const COLOURS: Array<[RegExp, Forms]> = [
  [/\b(light blue|l\. ?blue)\b|светлосин/i, forms("светлосин", "светлосиня", "светлосиньо", "светлосини")],
  [/\b(burgundy|bordeaux)\b|бордо/i, fixed("бордо")],
  [/\bmint\b|мента/i, fixed("мента")],
  [/\bblack\b|чер(ен|на|но|ни)/i, forms("черен", "черна", "черно", "черни")],
  [/\bwhite\b|бя(л|ла|ло)(?![а-я])|бели/i, forms("бял", "бяла", "бяло", "бели")],
  [/\bpink\b|розов/i, forms("розов", "розова", "розово", "розови")],
  [/\bblue\b|(?<![а-я])син(я|ьо|и)?(?![а-я])/i, forms("син", "синя", "синьо", "сини")],
  [/\b(grey|gray)\b|сив/i, forms("сив", "сива", "сиво", "сиви")],
  [/\bbeige\b|бежов/i, forms("бежов", "бежова", "бежово", "бежови")],
  [/\bbrown\b|кафяв/i, forms("кафяв", "кафява", "кафяво", "кафяви")],
  [/\borange\b|оранжев/i, forms("оранжев", "оранжева", "оранжево", "оранжеви")],
  [/\bred\b|червен/i, forms("червен", "червена", "червено", "червени")],
  [/\bgreen\b|зелен/i, forms("зелен", "зелена", "зелено", "зелени")],
  [/\bpurple\b|лилав/i, forms("лилав", "лилава", "лилаво", "лилави")],
  [/\bgold\b|златист/i, forms("златист", "златиста", "златисто", "златисти")],
  [/\bsilver\b|сребрист/i, forms("сребрист", "сребриста", "сребристо", "сребристи")],
];

const COLOUR_WORDS = /\b(light blue|l\. ?blue|burgundy|bordeaux|mint|black|white|pink|blue|grey|gray|beige|brown|orange|red|green|purple|gold|silver)\b/gi;

/** „Трицветен печат“ е десен, не цвят: цветът е последната част на заглавието. */
export function colourOf(p: ScrapedProduct, gender: Gender): string | null {
  const sources = [p.attributes["Цвят"] ?? ""];
  const parts = p.name.split(/\s+-\s+/);
  if (parts.length > 1) sources.push(parts[parts.length - 1]);
  sources.push(p.name.replace(/\([^)]*\)/g, " ").replace(/\s\/\s*[A-Z0-9][A-Z0-9-]*\s*$/i, " "));
  for (const text of sources) {
    if (!text.trim()) continue;
    for (const [re, f] of COLOURS) if (re.test(text)) return f[gender];
  }
  return null;
}

// ---- Свойство: мощност / дължина ----------------------------------------------------

export function powerOf(title: string): string | null {
  const values = [...title.matchAll(/(?:^|[\s(])(\d{1,3})\s*w\b/gi)].map((m) => Number(m[1]));
  if (!values.length) return null;
  return `${Math.max(...values)}W`;
}

export function lengthOf(p: ScrapedProduct): string | null {
  const raw = p.attributes["Дължина"] ?? "";
  const fromAttr = /^(\d+(?:[.,]\d+)?)\s*m$/i.exec(raw.trim());
  const fromTitle = /(?:^|[\s(])(\d+(?:[.,]\d+)?)\s*m\b/i.exec(p.name);
  const value = fromAttr?.[1] ?? fromTitle?.[1];
  return value ? `${value.replace(".", ",")} м` : null;
}

// ---- Серия ---------------------------------------------------------------------------

const KEEP_UPPER = new Set(["PU", "TPU", "PC", "IML", "4G", "3D", "K&C", "KC", "SW", "FW", "TWS", "HDMI", "USB", "USB-C", "USB-A", "PD", "QC", "MB", "HS"]);

function prettyWord(word: string): string {
  if (word.includes("/")) return word.split("/").map(prettyWord).join("/");
  if (/\d/.test(word)) return word; // 4G, PD20W+QC18W - както ги пише производителят
  const upper = word.toUpperCase();
  if (KEEP_UPPER.has(upper)) return upper;
  if (/^magsafe$/i.test(word)) return "MagSafe";
  if (/^\d/.test(word) || /[а-я]/i.test(word)) return word; // числа и кирилица - както са
  if (word === upper && word.length > 1) return word[0] + word.slice(1).toLowerCase();
  return word;
}

const DEVICE_SPAN = new RegExp(
  `\\b(?:IP|IPHONE\\s*)\\d{1,2}(?:\\s*(?:\\/|&)\\s*\\d{1,2})*(?:\\s+${SUFFIX}\\b)?|\\bGalaxy\\s+[A-Z]\\d{1,3}(?:\\s+(?:Ultra|Plus|FE))?`, "gi");

/** Код на производителя или вътрешен код в заглавието (EP-T6530NBEGEU-RETAIL, MHXH3ZM/A, DLC5206C/00). */
const CODE_TOKEN = /\b(?=[A-Z0-9/-]*\d)(?=[A-Z0-9/-]*[A-Z])[A-Z0-9]{2,}(?:[/-][A-Z0-9]+)+\b|\b[A-Z]{2,}\d[A-Z0-9]{4,}\b/g;

export function seriesOf(p: ScrapedProduct, kind: Kind, maker: string): string {
  let t = ` ${p.name} `;
  if (kind === "cable" || kind === "hdmi-cable") {
    t = t
      .replace(/\bType-C\s*-\s*Type-C\b/gi, "USB-C към USB-C")
      .replace(/\bUSB\s*A\s+to\s+USB\s*C\b/gi, "USB-A към USB-C")
      .replace(/\bUSB-C\s+to\s+USB-C\b/gi, "USB-C към USB-C");
  }
  t = t.replace(/\((?:плик|bulk|retail)\)/gi, " ")
    .replace(/[-/ ]*(?:bulk|retail)\b/gi, " ")
    .replace(/\s\/\s*[A-Z0-9][A-Z0-9-]*(?:\/[A-Z0-9-]+)?\s*$/i, " ") // „ /TA845XWEGWW“ накрая
    .replace(/^\s*(?:PTDK\s+)?\d{3,5}\s+/i, " ") // водещият код (последните цифри на EAN)
    .replace(DEVICE_SPAN, " ")
    .replace(/\((\d{1,3})\s*w\)/gi, " ")
    .replace(/\((\d+(?:[.,]\d+)?)\s*m\)/gi, " ")
    .replace(/(?:^|\s)\d{1,3}\s*w\b/gi, " ")
    .replace(/(?:^|\s)\d+(?:[.,]\d+)?\s*m\b/gi, " ")
    .replace(CODE_TOKEN, " ")
    .replace(/\b(?:HC|HQ|hardcase|back cover|cover|case)\b/gi, " ")
    .replace(/\bw\/\s*/gi, " with ")
    .replace(/(?:^|\s)(?:за\s+)?iphone\b,?/gi, " ")
    .replace(/(?:^|\s)(?:оригинал(?:ен|на|но|ни)|калъф|гръб|заден капак|кабел|адаптер|зарядно|безжично|магнитно|cable)(?=\s|$|,)/gi, " ")
    .replace(COLOUR_WORDS, " ")
    .replace(/(?:^|\s)(?:черен|черно|черна|бял|бяло|бяла|мента)(?=\s|$|,)/gi, " ");

  // Марката не се повтаря в серията (GUESS, KARL, MB, Mercedes, PHILIPS…).
  const makerWords = new Set([maker, ...maker.split(/[\s-]+/), "MB", "KARL", "GUESS", "Mercedes", "Mercedes-Benz"]
    .map((w) => w.toLowerCase()));
  const words = t
    .replace(/\s+-\s+/g, " ")
    .replace(/[,]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !makerWords.has(w.toLowerCase()));

  let series = words.map(prettyWord).join(" ");
  if (kind === "cable" || kind === "hdmi-cable") series = series.replace(/\bto\b/gi, "към");
  if (kind === "charger") series = series.replace(/\bFast charger\b/i, "Fast Charger");
  return series.replace(/\s+/g, " ").replace(/^[-\s]+|[-\s]+$/g, "").trim();
}

// ---- Името по схемата -------------------------------------------------------------

/** Телефонът в името, както го пише магазинът (catalogNaming.phoneDevice). */
export function deviceLabel(d: Device): string {
  if (d.brand === "Apple") return /^(iPhone|iPad|AirPods|Mac)/.test(d.model) ? d.model : `Apple ${d.model}`;
  if (d.brand === "Samsung") return /^galaxy/i.test(d.model) ? `Samsung ${d.model}` : `Samsung Galaxy ${d.model}`;
  return `${d.brand} ${d.model}`;
}

export function proposedName(p: ScrapedProduct, kind: Kind, maker: string, devices: Device[]): string {
  const { type, gender } = KIND_TYPE[kind];
  const series = seriesOf(p, kind, maker);
  const head = [type, maker, series].filter(Boolean).join(" ");
  const forPart = devices.length ? ` за ${devices.map(deviceLabel).join(" / ")}` : "";
  const props: string[] = [];
  if (kind === "cable" || kind === "hdmi-cable") {
    const length = lengthOf(p);
    if (length) props.push(length);
  }
  const power = kind === "case" || kind === "earbuds" ? null : powerOf(p.name);
  if (power && !head.includes(power)) props.push(power);
  const colour = colourOf(p, gender);
  const body = `${head}${forPart}${props.length ? `, ${props.join(", ")}` : ""}`;
  return colour ? `${body} - ${colour}` : body;
}

// ---- Целият ред ---------------------------------------------------------------------

export function buildShopRow(p: ScrapedProduct): BuildResult {
  const kind = kindOf(p.categoryPath, p.name);
  if (!kind) return { skip: `непозната категория ${p.categoryPath}` };
  const prices = priceFromLstar(p.priceEur);
  if (!prices) return { skip: "няма цена" };
  const id = Number(p.productId);
  if (!Number.isInteger(id) || id <= 0) return { skip: "няма id" };

  const maker = canonicalMaker(p.attributes["Марка"] || p.brand || "");
  const isPhoneSpecific = kind === "case";
  const devices = isPhoneSpecific ? devicesFor(p) : [];
  const needsModel = isPhoneSpecific && devices.length === 0;
  const primary = devices[0];
  const brand = isPhoneSpecific ? (primary?.brand ?? ALL_BRANDS) : (maker || ALL_BRANDS);
  const model = isPhoneSpecific ? (primary?.model ?? MODEL_LESS) : MODEL_LESS;

  // Кодът на производителя е онова, по което Koff продава същата стока. Вътрешният
  // код на LStar (5-8 цифри) и EAN-ът не са такъв код.
  const code = p.sku && classifyModel(p.sku) === "manufacturer" && !/[а-я]/i.test(p.sku) ? p.sku.trim() : "";

  return {
    row: {
      sourceKey: `${LSTAR_SOURCE_KEY_PREFIX}${id}`,
      sourceProductId: id,
      supplierName: p.name,
      proposedName: proposedName(p, kind, maker, devices),
      description: p.description,
      supplierCategory: p.categoryName,
      supplierUrl: `https://lstarbg.com/index.php?route=product/product&product_id=${id}`,
      image: p.images[0] ?? "",
      images: p.images,
      stock: p.inStock === true ? IN_STOCK_QUANTITY : 0,
      priceB2C: prices.priceB2C,
      priceB2B: prices.priceB2B,
      costPrice: prices.base,
      ean: p.ean,
      supplierSku: code,
      publicMaker: maker,
      category: KIND_CATEGORY[kind],
      brand,
      model,
      compat: devices.slice(1).map((d) => ({ brand: d.brand, model: d.model })),
      needsModel,
    },
  };
}
