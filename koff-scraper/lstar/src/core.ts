// Сърцевината на скрейпъра: обхожда категориите, отваря продуктовите страници,
// сглобява редовете за CSV и доклада. Не знае как се прави заявка - получава
// готова функция fetchText(url), така че същият код върви и в Node (с логин),
// и в браузър (с вече логната сесия) за тестовия рън.

import {
  classifyModel,
  isValidEan13,
  parseCategoryPage,
  parseProductPage,
  priceWithVat,
  type ListingProduct,
  type PriceBasis,
} from "./parse.js";

export const BASE_URL = "https://lstarbg.com";
export const DEFAULT_CATEGORY_PATHS = ["496_567", "496_569", "496_570"];
/**
 * Сайтът показва цените без ДДС (vatCounterpart.shownBasis = "exclusive").
 * Ако продуктова страница не се отвори и цената дойде само от листинга,
 * ползваме този режим, за да не запишем чиста (без ДДС) цена като цена с ДДС.
 */
const DEFAULT_PRICE_BASIS: PriceBasis = "exclusive";
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
  /** Как сайтът показва цените и как са превърнати в цени с ДДС. */
  priceBasis: string;
  categories: CategoryReport[];
  uniqueProducts: number;
  duplicatesAcrossCategories: number;
  productPageErrors: number;
  eanCount: number;
}

export interface ScrapeOptions {
  fetchText: (url: string) => Promise<string>;
  /** Превежда стар адрес през 308 пренасочването му (client.resolveUrl). */
  resolveUrl?: (url: string) => Promise<string>;
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

/** Старият адрес на категорията; сайтът го пренасочва към новия /categories/... */
function legacyCategoryUrl(path: string): string {
  return `${BASE_URL}/index.php?route=product/category&path=${path}`;
}

/** Новият сайт показва по 50 продукта на страница: ?page=2, ?page=3... */
function categoryPageUrl(base: string, page: number): string {
  return page === 1 ? base : `${base}?page=${page}`;
}


export function formatPrice(value: number | null): string {
  return value === null ? "" : value.toFixed(2);
}

async function readCategory(
  path: string,
  fetchText: ScrapeOptions["fetchText"],
  resolveUrl: (url: string) => Promise<string>,
  log: (m: string) => void
): Promise<{ name: string; declaredTotal: number | null; products: ListingProduct[] }> {
  const products: ListingProduct[] = [];
  const seen = new Set<string>();
  let name = "";
  let declaredTotal: number | null = null;
  let pages = 1;

  // Старият адрес (496_567) се пренасочва към новия /categories/... – така
  // не зависим от това как са кръстили категорията днес.
  const base = (await resolveUrl(legacyCategoryUrl(path))).replace(/\/+$/, "");

  for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
    const url = categoryPageUrl(base, page);
    const parsed = parseCategoryPage(await fetchText(url));
    if (!parsed.loggedIn) throw new SessionLostError(`категория ${path}, страница ${page}`);
    if (page === 1) {
      if (parsed.products.length === 0 && parsed.total === null) {
        throw new Error(`категория ${path}: страницата не върна продукти (${url}) - сайтът може да е сменен`);
      }
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
    if (added === 0) break;
  }
  return { name, declaredTotal, products };
}

export async function scrapeLstar(options: ScrapeOptions): Promise<{ rows: CsvRow[]; products: ScrapedProduct[]; report: ScrapeReport }> {
  const {
    fetchText,
    resolveUrl = async (url: string) => url,
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
  let missingPriceTotal = 0;
  // Режимът на цените (с/без ДДС) е един за целия сайт – взимаме го от първата
  // продуктова страница и го ползваме и когато страница не се отвори.
  let siteBasis: PriceBasis = DEFAULT_PRICE_BASIS;

  for (const path of categoryPaths) {
    log(`Категория ${path}`);
    const { name, declaredTotal, products } = await readCategory(path, fetchText, resolveUrl, log);
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
        if (page.priceBasis === "inclusive" || page.priceBasis === "exclusive") {
          siteBasis = page.priceBasis;
        }
      } catch (error) {
        if (error instanceof SessionLostError) throw error;
        productPageErrors++;
        notes.push("продуктовата страница не се отвори");
      }

      // Цената се превръща в цена с ДДС на едно място – за листинга и за
      // продуктовата страница по един и същ множител.
      const vatRatio = page?.vatRatio ?? 1.2;
      const listingPrice = priceWithVat(item.priceEur, siteBasis, vatRatio);
      const pagePrice = priceWithVat(page?.priceEur ?? null, siteBasis, vatRatio);

      let price = listingPrice;
      if (price === null && pagePrice !== null) {
        price = pagePrice;
        report.priceFilledFromProductPage++;
        notes.push("цена от продуктовата страница");
      } else if (price !== null && pagePrice !== null && Math.abs(price - pagePrice) > 0.005) {
        notes.push(`цена в листинга ${formatPrice(price)}, на страницата ${formatPrice(pagePrice)}`);
      }
      if (price === null) {
        report.missingPriceEverywhere++;
        missingPriceTotal++;
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
      // Само истински код на производителя влиза в колоната "sku". Новият
      // сайт дава като sku вътрешния номер на варианта (число) – той не е SKU
      // и не бива да отива в магазина.
      const sku =
        /[A-Za-z]/.test(pageSku) && pageSku.length >= 3
          ? pageSku
          : kind === "manufacturer"
            ? model
            : "";
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

  // Ако нито един продукт няма цена, най-вероятно сайтът крие цените (сесията
  // е изтекла или входът не е минал). По-добре да спрем, отколкото да запишем
  // 200 продукта без цени.
  if (scraped.length >= 5 && missingPriceTotal === scraped.length) {
    throw new SessionLostError("нито един продукт няма цена - сайтът крие цените");
  }

  const priceBasis =
    siteBasis === "exclusive"
      ? "сайтът показва цените без ДДС; превърнати в цени с ДДС (x1.2)"
      : siteBasis === "inclusive"
        ? "сайтът показва цените с ДДС; непреобразувани"
        : "сайтът не каза дали цените са с ДДС; оставени както са";

  return {
    rows,
    products: scraped,
    report: {
      startedAt,
      finishedAt: now().toISOString(),
      vatIncluded,
      priceBasis,
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
