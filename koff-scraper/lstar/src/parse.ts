// Чисти функции за разчитане на страниците на lstarbg.com.
//
// От 21.10.2026 сайтът е Next.js. Данните за продуктите вече не са HTML, а
// JSON в self.__next_f (src/next-payload.ts). Затова:
//   - категориите се четат от списъка с продукти в payload-а;
//   - продуктовата страница – от обекта с productHandle/variants/specRows.
// HTML се чете само за заглавието на категорията (<h1>), защото то е просто
// текст и така не зависим от вътрешната структура на payload-а.
//
// Модулът е без мрежа: работи еднакво в Node и в браузър (тестовият рън).

import { parse } from "node-html-parser";
import {
  extractFlightText,
  findObject,
  findObjectArrays,
  num,
  parseFlightRows,
  str,
  walkObjects,
  type JsonObject,
} from "./next-payload.js";

export const LSTAR_BASE_URL = "https://lstarbg.com";

export interface ListingProduct {
  productId: string;
  url: string;
  brand: string;
  model: string;
  name: string;
  /** Цена в EUR от листинга, както я показва сайтът, или null ако там няма цена. */
  priceEur: number | null;
}

export interface CategoryPage {
  name: string;
  /** Общ брой продукти според "resultCount" на сайта. */
  total: number | null;
  /** Брой страници – изчислява се от общия брой и дължината на една страница. */
  pages: number | null;
  products: ListingProduct[];
  /** Логната ли е сесията. Сайтът крие цените от нелогнати клиенти. */
  loggedIn: boolean;
}

/** Дали цената от payload-а е с ДДС или без. */
export type PriceBasis = "inclusive" | "exclusive" | "unknown";

export interface ProductPage {
  name: string;
  brand: string;
  model: string;
  /** SKU на производителя (mpn); ако липсва – вътрешният номер на варианта. */
  sku: string;
  /** Цената, както я дава сайтът – виж priceBasis, преди да я ползваш за база. */
  priceEur: number | null;
  priceBasis: PriceBasis;
  /** Колко е ДДС множителят според сайта (обикновено 1.2 = 20 %). */
  vatRatio: number;
  /** true = поне един вариант е наличен, false = всички са изчерпани, null = неизвестно. */
  inStock: boolean | null;
  loggedIn: boolean;
  /** Снимките от галерията, в реда на сайта, като абсолютни адреси. */
  images: string[];
  /** Таблицата „Спецификации“: „Модел Телефон“, „Бранд“, „Марка“, „Цвят“, „Дължина“… */
  attributes: Record<string, string>;
  /** Текстът от описанието, без HTML. */
  description: string;
}

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

function stripHtml(html: string): string {
  return clean(
    html
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
      .replace(/\s+([.,;:!?])/g, "$1"),
  );
}

const flightRows = (html: string): unknown[] => parseFlightRows(extractFlightText(html));

/**
 * "€14.17", "14,17 €", "€1,234.56", "1 234,56 €" -> число. null ако няма цифри.
 * Последният разделител (. или ,) с 1-2 цифри след него е десетичният.
 */
export function parsePriceEur(text: string | null | undefined): number | null {
  const raw = clean(text).replace(/[^\d.,]/g, "");
  if (!/\d/.test(raw)) return null;
  const m = raw.match(/^(.*?)[.,](\d{1,2})$/);
  const intPart = (m ? m[1] : raw).replace(/[.,]/g, "");
  const value = Number(m ? `${intPart}.${m[2]}` : intPart);
  return Number.isFinite(value) ? value : null;
}

/**
 * Цена с ДДС. Сайтът показва цените без ДДС (shownBasis "exclusive"), а
 * магазинът работи с цени с ДДС, затова тук се умножава по множителя на сайта.
 * Ако сайтът вече дава цена с ДДС, числото се връща непроменено.
 */
export function priceWithVat(
  value: number | null,
  basis: PriceBasis,
  vatRatio: number,
): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (basis !== "exclusive" || !Number.isFinite(vatRatio) || vatRatio <= 1) return value;
  return Math.round(value * vatRatio * 100) / 100;
}

// ---- Категория ------------------------------------------------------------------

/** Продуктова карта в листинга: има адрес, вариант и име. */
function isListingCard(o: JsonObject): boolean {
  return (
    typeof o.urlHandle === "string" &&
    typeof o.defaultVariantPublicId === "string" &&
    typeof o.name === "string"
  );
}

/** Снимка/атрибути, които идват като относителен път, стават абсолютни. */
function absoluteUrl(path: string): string {
  if (!path) return "";
  if (/^https:\/\//.test(path)) return path;
  return path.startsWith("/") ? `${LSTAR_BASE_URL}${path}` : "";
}

export function parseCategoryPage(html: string): CategoryPage {
  const rows = flightRows(html);

  const cards = findObjectArrays(rows, isListingCard)
    .sort((a, b) => b.length - a.length)[0] ?? [];

  const seen = new Set<string>();
  const products: ListingProduct[] = [];
  for (const card of cards) {
    const id = num(card.id);
    if (id === null || !Number.isInteger(id) || id <= 0) continue;
    const productId = String(id);
    if (seen.has(productId)) continue;
    seen.add(productId);
    const handle = str(card.urlHandle);
    products.push({
      productId,
      url: `${LSTAR_BASE_URL}/products/${handle}-${str(card.defaultVariantPublicId)}`,
      brand: str(card.manufacturerName),
      // Model (вътрешният код) го няма в листинга на новия сайт – идва от
      // продуктовата страница.
      model: "",
      name: str(card.name),
      priceEur: num(card.minPrice) ?? num(card.defaultPrice),
    });
  }

  // "resultCount" и "pricesHidden" се срещат в няколко вложени обекта на
  // страницата (sidebar, списък, layout), затова ги събираме поотделно.
  let total: number | null = null;
  let pricesHidden: boolean | null = null;
  walkObjects(rows, (object) => {
    if (total === null && typeof object.resultCount === "number") total = object.resultCount;
    if (pricesHidden === null && typeof object.pricesHidden === "boolean") {
      pricesHidden = object.pricesHidden;
    }
  });
  // Сайтът крие цените от нелогнати клиенти – това е сигурният признак, че
  // сесията е изтекла (или входът не е минал).
  const loggedIn = pricesHidden !== true;

  const heading = clean(parse(html).querySelector("#content h1, h1")?.text)
    .replace(/\s*\(\d+\)\s*$/, "");
  const name = heading;

  const pages =
    total !== null && products.length > 0 ? Math.max(1, Math.ceil(total / products.length)) : null;

  return { name, total, pages, products, loggedIn };
}

// ---- Продуктова страница ---------------------------------------------------------

function isProductObject(o: JsonObject): boolean {
  return typeof o.productHandle === "string" && Array.isArray(o.variants);
}

function specRowsOf(rows: unknown[]): Record<string, string> {
  const holder = findObject(rows, (o) => Array.isArray(o.specRows));
  const attributes: Record<string, string> = {};
  if (!holder || !Array.isArray(holder.specRows)) return attributes;
  for (const row of holder.specRows) {
    if (typeof row !== "object" || row === null) continue;
    const spec = row as JsonObject;
    const label = clean(str(spec.label));
    const values = Array.isArray(spec.values) ? spec.values.map((v) => clean(str(v))).filter(Boolean) : [];
    if (label && values.length && !(label in attributes)) attributes[label] = values.join(", ");
  }
  return attributes;
}

function imagesOf(product: JsonObject): string[] {
  const images: string[] = [];
  const galleries = Array.isArray(product.galleryVariants) ? product.galleryVariants : [];
  for (const gallery of galleries) {
    if (typeof gallery !== "object" || gallery === null) continue;
    const list = (gallery as JsonObject).images;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const url = absoluteUrl(str(raw));
      if (!url) continue;
      // Само снимки от самия сайт – както досега.
      if (!/^https:\/\/lstarbg\.com\/(uploads|image)\//.test(url)) continue;
      if (!images.includes(url)) images.push(url);
    }
  }
  return images;
}

export function parseProductPage(html: string): ProductPage {
  const rows = flightRows(html);
  const product = findObject(rows, isProductObject);
  if (!product) {
    throw new Error("страницата не съдържа продукт (не е продуктова страница или сайтът е сменен)");
  }

  const variants = (product.variants as JsonObject[]).filter(
    (v): v is JsonObject => typeof v === "object" && v !== null,
  );
  const main = variants[0] ?? {};

  const priceRaw = num(main.salePrice) ?? num(main.price);
  const vat = (product.vatCounterpart ?? {}) as JsonObject;
  const basisRaw = str(vat.shownBasis);
  const priceBasis: PriceBasis =
    basisRaw === "inclusive" || basisRaw === "exclusive" ? basisRaw : "unknown";
  const ratio = (vat.ratio ?? {}) as JsonObject;
  const numerator = num(ratio.numerator);
  const denominator = num(ratio.denominator);
  const vatRatio =
    numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : 1.2;

  let inStock: boolean | null = null;
  if (variants.length) {
    inStock = variants.some(
      (v) => v.availableForSale === true && (num(v.inStock) ?? 0) > 0,
    );
  }

  const manufacturer = (product.manufacturer ?? {}) as JsonObject;
  const sku = str(product.mpn) || str(main.sku);

  return {
    name: clean(str(product.productName)),
    brand: clean(str(manufacturer.name)),
    model: clean(str(product.model)),
    sku: clean(sku),
    priceEur: priceRaw !== null && priceRaw > 0 ? priceRaw : null,
    priceBasis,
    vatRatio,
    inStock,
    // На продуктовата страница няма флаг pricesHidden – ако сесията е изтекла,
    // цената просто липсва; core спира при категория без нито една цена.
    loggedIn: true,
    images: imagesOf(product),
    attributes: specRowsOf(rows),
    description: stripHtml(str(product.descriptionHtml) || "").slice(0, 3000),
  };
}

// ---- Идентификатори ---------------------------------------------------------

export type ModelKind = "ean" | "internal" | "manufacturer";

/**
 * Какво е съдържанието на колоната "model".
 * 13 цифри = EAN; само цифри с дължина 5-8 = вътрешен код на LStar (обикновено
 * 7, но в тестовия рън на 2026-10-19 се срещнаха и 6-цифрени, напр. 949736);
 * всичко друго = SKU на производителя.
 */
export function classifyModel(model: string): ModelKind {
  const m = model.trim();
  if (/^\d{13}$/.test(m)) return "ean";
  if (/^\d{5,8}$/.test(m)) return "internal";
  return "manufacturer";
}

export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[12];
}
