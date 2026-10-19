// Сърцевината на скрейпъра: обхожда категориите, отваря продуктовите страници,
// сглобява редовете за CSV и доклада. Не знае как се прави заявка - получава
// готова функция fetchText(url), така че същият код върви и в Node (с логин),
// и в браузър (с вече логната сесия) за тестовия рън.

import {
  classifyModel,
  isValidEan13,
  parseCategoryPage,
  parseProductPage,
  type ListingProduct,
} from "./parse.js";

export const BASE_URL = "https://lstarbg.com";
export const DEFAULT_CATEGORY_PATHS = ["496_567", "496_569", "496_570"];
/** Максимумът, който OpenCart приема в "Покажи:" на този сайт. */
const PAGE_LIMIT = 100;
/** Предпазител: никога повече от толкова страници на категория. */
const MAX_PAGES = 50;

export type VatFlag = "yes" | "no" | "unconfirmed";

export interface CsvRow {
  brand: string;
  name: string;
  sku: string;
  ean: string;
  price_eur: string;
  price_vat_included: VatFlag;
  note: string;
}

/** Всичко, което магазинът ползва за един продукт (lstar-products.json). */
export interface ScrapedProduct {
  productId: string;
  url: string;
  categoryPath: string;
  categoryName: string;
  brand: string;
  name: string;
  model: string;
  sku: string;
  ean: string;
  priceEur: number | null;
  inStock: boolean | null;
  images: string[];
  attributes: Record<string, string>;
  description: string;
}

export interface CategoryReport {
  path: string;
  name: string;
  /** Брой, който сайтът обявява. */
  declaredTotal: number | null;
  /** Брой, който реално прочетохме. */
  scraped: number;
  missingPriceInListing: number;
  priceFilledFromProductPage: number;
  missingPriceEverywhere: number;
  outOfStock: number;
}

export interface ScrapeReport {
  startedAt: string;
  finishedAt: string;
  vatIncluded: VatFlag;
  categories: CategoryReport[];
  uniqueProducts: number;
  duplicatesAcrossCategories: number;
  productPageErrors: number;
  eanCount: number;
}

export interface ScrapeOptions {
  fetchText: (url: string) => Promise<string>;
  categoryPaths?: string[];
  vatIncluded?: VatFlag;
  log?: (message: string) => void;
  now?: () => Date;
}

export class SessionLostError extends Error {
  constructor(where: string) {
    super(`Сесията към lstarbg.com не е логната (${where}) - спирам, без да пиша непълни данни`);
    this.name = "SessionLostError";
  }
}

function categoryUrl(path: string, page: number): string {
  return `${BASE_URL}/index.php?route=product/category&path=${path}&limit=${PAGE_LIMIT}&page=${page}`;
}

export function formatPrice(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

async function readCategory(
  path: string,
  fetchText: ScrapeOptions["fetchText"],
  log: (m: string) => void
): Promise<{ name: string; declaredTotal: number | null; products: ListingProduct[] }> {
  const products: ListingProduct[] = [];
  const seen = new Set<string>();
  let name = "";
  let declaredTotal: number | null = null;
  let pages = 1;

  for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
    const parsed = parseCategoryPage(await fetchText(categoryUrl(path, page)));
    if (!parsed.loggedIn) throw new SessionLostError(`категория ${path}, страница ${page}`);
    if (page === 1) {
      name = parsed.name;
      declaredTotal = parsed.total;
      pages = parsed.pages ?? 1;
    }
    let added = 0;
    for (const p of parsed.products) {
      if (seen.has(p.productId)) continue;
      seen.add(p.productId);
      products.push(p);
      added++;
    }
    log(`  ${path} стр. ${page}/${pages}: +${added} продукта`);
    if (added === 0) break; // OpenCart връща последната страница отново при page > max
  }
  return { name, declaredTotal, products };
}

export async function scrapeLstar(options: ScrapeOptions): Promise<{ rows: CsvRow[]; products: ScrapedProduct[]; report: ScrapeReport }> {
  const {
    fetchText,
    categoryPaths = DEFAULT_CATEGORY_PATHS,
    vatIncluded = "unconfirmed",
    log = () => {},
    now = () => new Date(),
  } = options;

  const startedAt = now().toISOString();
  const rows: CsvRow[] = [];
  const scraped: ScrapedProduct[] = [];
  const categories: CategoryReport[] = [];
  const done = new Set<string>();
  let duplicates = 0;
  let productPageErrors = 0;
  let eanCount = 0;

  for (const path of categoryPaths) {
    log(`Категория ${path}`);
    const { name, declaredTotal, products } = await readCategory(path, fetchText, log);
    const report: CategoryReport = {
      path,
      name,
      declaredTotal,
      scraped: products.length,
      missingPriceInListing: 0,
      priceFilledFromProductPage: 0,
      missingPriceEverywhere: 0,
      outOfStock: 0,
    };

    for (const item of products) {
      if (done.has(item.productId)) {
        duplicates++;
        continue;
      }
      done.add(item.productId);

      const notes: string[] = [`id ${item.productId}`, `категория ${path}`];
      if (item.priceEur === null) report.missingPriceInListing++;

      // Продуктовата страница дава SKU на производителя и наличност, а при
      // липсваща цена в листинга - и цената. Затова я отваряме за всеки продукт.
      let page = null;
      try {
        page = parseProductPage(await fetchText(item.url));
        if (!page.loggedIn) throw new SessionLostError(`продукт ${item.productId}`);
      } catch (error) {
        if (error instanceof SessionLostError) throw error;
        productPageErrors++;
        notes.push("продуктовата страница не се отвори");
      }

      let price = item.priceEur;
      if (price === null && page?.priceEur != null) {
        price = page.priceEur;
        report.priceFilledFromProductPage++;
        notes.push("цена от продуктовата страница");
      } else if (price !== null && page?.priceEur != null && Math.abs(price - page.priceEur) > 0.005) {
        notes.push(`цена в листинга ${formatPrice(price)}, на страницата ${formatPrice(page.priceEur)}`);
      }
      if (price === null) {
        report.missingPriceEverywhere++;
        notes.push("НЯМА ЦЕНА - нито в листинга, нито на продуктовата страница");
      }

      if (page?.inStock === false) {
        report.outOfStock++;
        notes.push("изчерпан");
      }

      const model = item.model || page?.model || "";
      const kind = classifyModel(model);
      let ean = "";
      if (kind === "ean") {
        ean = model;
        eanCount++;
        if (!isValidEan13(model)) notes.push("EAN с невалидна контролна цифра");
      } else if (kind === "internal") {
        notes.push(`вътрешен код ${model}`);
      }

      const pageSku = page?.sku ?? "";
      const sku = pageSku || (kind === "manufacturer" ? model : "");
      if (!sku) notes.push("няма SKU на производителя");

      scraped.push({
        productId: item.productId,
        url: item.url,
        categoryPath: path,
        categoryName: name,
        brand: item.brand || page?.brand || "",
        name: item.name || page?.name || "",
        model,
        sku,
        ean,
        priceEur: price,
        inStock: page?.inStock ?? null,
        images: page?.images ?? [],
        attributes: page?.attributes ?? {},
        description: (page?.description ?? "").slice(0, 3000),
      });

      rows.push({
        brand: item.brand || page?.brand || "",
        name: item.name || page?.name || "",
        sku,
        ean,
        price_eur: formatPrice(price),
        price_vat_included: vatIncluded,
        note: notes.join(", "),
      });
    }

    categories.push(report);
    log(`  → ${name}: ${report.scraped} продукта, без цена навсякъде: ${report.missingPriceEverywhere}`);
  }

  return {
    rows,
    products: scraped,
    report: {
      startedAt,
      finishedAt: now().toISOString(),
      vatIncluded,
      categories,
      uniqueProducts: rows.length,
      duplicatesAcrossCategories: duplicates,
      productPageErrors,
      eanCount,
    },
  };
}

// ---- CSV ----------------------------------------------------------------------

export const CSV_HEADER = ["brand", "name", "sku", "ean", "price_eur", "price_vat_included", "note"] as const;

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV с разделител ";" и BOM, за да се отваря правилно на кирилица в Excel. */
export function toCsv(rows: CsvRow[]): string {
  const lines = [CSV_HEADER.join(";")];
  for (const row of rows) lines.push(CSV_HEADER.map((k) => csvField(row[k])).join(";"));
  return "﻿" + lines.join("\r\n") + "\r\n";
}
