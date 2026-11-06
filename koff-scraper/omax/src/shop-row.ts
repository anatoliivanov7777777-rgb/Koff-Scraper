// Продукт от Omax → ред за магазина (convex/omaxSync.ts в CaseKing).
//
//  - цени: схемата на LStar - CASEKING PRICING v2 върху цената на Omax, която
//    вече е С ДДС (без ×1.23); долна граница 9.99 € / 1.99 €, цени на .99;
//  - само налични продукти; наличен = 5 бр. (Omax не дава количество);
//  - калъф/протектор/камера само за телефон, който магазинът вече има;
//  - зарядни, кабели и авто: модел "Всички модели", марка = производителят;
//  - име по схемата: [тип] [марка/серия] за [модел] - [цвят].

// @ts-expect-error - споделеният модул е чист JS без типове
import { calcB2BPrice, calcB2CPrice } from "../../scraper/pricing.mjs";
import { KIND_CATEGORY, PHONE_KINDS, type Kind } from "./categories.js";
import { devicesFor, type Device, type ModelIndex } from "./models.js";
import { BASE_URL } from "./parse.js";

export const OMAX_SOURCE_KEY_PREFIX = "omax-sync:";
export const MODEL_LESS = "Всички модели";
export const ALL_BRANDS = "Всички марки";
export const IN_STOCK_QUANTITY = 5;

export interface ScrapedProduct {
  productId: number;
  name: string;
  href: string;
  priceEur: number;
  kind: Kind;
  categoryPath: string;
  ean: string;
  images: string[];
  description: string;
}

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
  previousName?: string;
}

export type BuildResult = { row: ShopRow } | { skip: string };

// Производителите, които Omax слага първа дума в заглавието.
const MAKERS: Record<string, string> = {
  nordic: "Nordic", baseus: "Baseus", ugreen: "Ugreen", xo: "XO", hoco: "Hoco", ldnio: "LDNIO", anker: "Anker",
  esr: "ESR", spigen: "Spigen", guess: "Guess", nillkin: "Nillkin", joyroom: "Joyroom", anank: "Anank",
  boter: "Boter", vention: "Vention", pitaka: "Pitaka", uag: "UAG", supcase: "Supcase", kingxbar: "Kingxbar",
  nimbo: "Nimbo", dkny: "DKNY", amg: "AMG", lacoste: "Lacoste", ddpai: "DDPAI",
};

/** Производителят: първата позната дума в заглавието ("HOCO", "... NORDIC"). */
export function makerOf(title: string): string {
  const text = title.trim();
  if (/(^|\s)karl lagerfeld(\s|$)/i.test(text)) return "Karl Lagerfeld";
  if (/(^|\s)red bull(\s|$)/i.test(text)) return "Red Bull";
  for (const word of text.split(/[\s,/]+/)) {
    const maker = MAKERS[word.toLowerCase()];
    if (maker !== undefined) return maker;
  }
  return "";
}

/** Кодът на производителя в края: "... - A2318M", "... - DP139 / 95418". */
export function codeOf(title: string): string {
  const m = /\s-\s([A-Za-z0-9][A-Za-z0-9._-]{2,})(?:\s*\/\s*\d+)?\s*$/.exec(title.trim());
  if (!m) return "";
  const code = m[1];
  return /\d/.test(code) && /[A-Za-z]/.test(code) ? code : "";
}

/** Цветът е последният сегмент между наклонени черти: "/черен/". */
export function colourOf(title: string): string {
  const m = /\/([^/\d][^/]*)\/\s*(?:[A-Z]{2,}\s*)?$/.exec(title.trim()) ?? /\/([^/\d][^/]*)\/(?:\s|$)/.exec(title);
  if (!m) return "";
  const colour = m[1].trim();
  return /^[а-яё\s,-]+$/i.test(colour) && colour.length <= 40 ? colour : "";
}

const TYPE_WORDS: Record<Kind, string> = {
  case: "Калъф",
  screen: "Стъклен протектор",
  camera: "Протектор за камера",
  charger: "Зарядно",
  wireless: "Безжично зарядно",
  cable: "Кабел",
  car: "",
};

// Думите на типа, които махаме от серията, защото типът е отпред на български.
// (\b в JS не работи с кирилица - затова граници по \p{L}.)
const STRIP_WORDS = /(?<!\p{L})(калъф|стъклен протектор|протектор|tempered glass|premium glass|glass|camera lens|camera|lens)(?!\p{L})/giu;

function seriesOf(title: string, kind: Kind): string {
  // До марката на телефона: всичко след нея е модел/цвят.
  const brandAt = title.search(/\s(Apple|iPhone|Samsung|Xiaomi|RedMi|Redmi|POCO|Poco|Huawei|Honor|Motorola|Moto|Google|Pixel|OnePlus|Realme|Oppo|OPPO|Nokia|Vivo|Nothing|Sony|ZTE|Tecno|Infinix|TCL)\b/);
  let series = brandAt >= 0 ? title.slice(0, brandAt) : title;
  series = series.replace(STRIP_WORDS, " ");
  if (kind === "camera") series = series.replace(/\b3D\b/i, (m) => m);
  // Допълнението след модела: "..., Crystal Clear", "..., MagSafe".
  const after = brandAt >= 0 ? title.slice(brandAt) : "";
  const tail = /,\s*([^/,]+?)(?:\s*\/[^/]*\/)?\s*$/.exec(after);
  const extra = tail && !/^\s*\d/.test(tail[1]) ? tail[1].trim() : "";
  return [series, extra].join(" ").replace(/\s+/g, " ").trim();
}

// Телефонът в името - същото правило като deviceName/phoneDevice на магазина
// (convex/catalogNaming.ts), за да изглеждат имената като останалите:
// "Samsung Galaxy S26 Ultra", "Xiaomi Redmi 9C", "Motorola Edge 70", "iPhone 16".
const SAMSUNG_GALAXY = /^(S\d|A\d|M\d|F\d|Z |Note|Tab|XCover|Xcover)/i;
export function deviceLabel(d: Device): string {
  const m = d.model.trim();
  if (d.brand === "Apple") return /^(iPhone|iPad|AirPods|Mac)/.test(m) ? m : `Apple ${m}`;
  if (d.brand === "Samsung") {
    if (m.toLowerCase().startsWith("galaxy")) return `Samsung ${m}`;
    return SAMSUNG_GALAXY.test(m) ? `Samsung Galaxy ${m}` : `Samsung ${m}`;
  }
  if (d.brand === "MOTO") return `Motorola ${m.replace(/^(Motorola|MOTO)\s+/i, "")}`;
  if (m.toLowerCase().startsWith(d.brand.toLowerCase())) return m;
  return `${d.brand} ${m}`;
}

/** Старото изписване (до 06.11.2026) - само за да се разпознае и преименува старо име. */
function legacyDeviceLabel(d: Device): string {
  if (d.brand === "Samsung" && !/^galaxy/i.test(d.model)) return `Samsung ${d.model}`;
  if (["Apple", "Xiaomi", "MOTO", "Google"].includes(d.brand)) return d.model;
  return `${d.brand} ${d.model}`;
}

export function proposedName(title: string, kind: Kind, devices: Device[], label: (d: Device) => string = deviceLabel): string {
  const colour = colourOf(title);
  if (PHONE_KINDS.has(kind)) {
    const series = seriesOf(title, kind);
    const name = `${TYPE_WORDS[kind]} ${series} за ${label(devices[0])}`.replace(/\s+/g, " ").trim();
    return colour ? `${name} - ${colour}` : name;
  }
  // Зарядни, кабели, авто: заглавието на Omax без кода в края, с българския тип
  // отпред, ако заглавието още не започва с него.
  let text = title.replace(/\s-\s[A-Za-z0-9][A-Za-z0-9._-]{2,}(?:\s*\/\s*\d+)?\s*$/, "").replace(/\s+/g, " ").trim();
  text = text.replace(/\s*\/([^/]+)\/\s*$/, (_m, c) => ` - ${c.trim()}`);
  const type = TYPE_WORDS[kind];
  if (!type || new RegExp(`(^|\\s)${type.split(" ")[0]}`, "i").test(text) || /зарядн|кабел|холдер|стойк|трансмитер/i.test(text.split(" ").slice(0, 3).join(" "))) {
    return text;
  }
  return `${type} ${text}`;
}

export function buildShopRow(p: ScrapedProduct, index: ModelIndex): BuildResult {
  const prices = p.priceEur > 0
    ? { base: p.priceEur, priceB2C: (calcB2CPrice as (b: number) => number)(p.priceEur), priceB2B: (calcB2BPrice as (b: number) => number)(p.priceEur) }
    : null;
  if (!prices) return { skip: "няма цена" };
  if (!Number.isInteger(p.productId) || p.productId <= 0) return { skip: "няма id" };
  const images = p.images.filter(Boolean);
  if (!images.length) return { skip: "няма снимка" };

  let kind = p.kind;
  if (kind === "screen" && /camera|камера|lens/i.test(p.name)) kind = "camera";

  const maker = makerOf(p.name);
  const isPhone = PHONE_KINDS.has(kind);
  const devices = isPhone ? devicesFor(p.name, index) : [];
  if (isPhone && devices.length === 0) return { skip: "телефонът не е в магазина" };
  const primary = devices[0];
  const name = proposedName(p.name, kind, devices);
  const legacy = isPhone ? proposedName(p.name, kind, devices, legacyDeviceLabel) : name;

  return {
    row: {
      sourceKey: `${OMAX_SOURCE_KEY_PREFIX}${p.productId}`,
      sourceProductId: p.productId,
      supplierName: p.name,
      proposedName: name,
      description: p.description,
      supplierCategory: p.categoryPath,
      supplierUrl: `${BASE_URL}${p.href.startsWith("/") ? "" : "/"}${p.href}`,
      image: images[0],
      images,
      stock: IN_STOCK_QUANTITY,
      priceB2C: prices.priceB2C,
      priceB2B: prices.priceB2B,
      costPrice: prices.base,
      ean: p.ean,
      supplierSku: codeOf(p.name),
      publicMaker: maker,
      category: KIND_CATEGORY[kind],
      brand: isPhone ? primary.brand : (maker || ALL_BRANDS),
      model: isPhone ? primary.model : MODEL_LESS,
      compat: devices.slice(1).map((d) => ({ brand: d.brand, model: d.model })),
      ...(legacy !== name ? { previousName: legacy } : {}),
    },
  };
}
