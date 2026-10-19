// Чисти функции за разчитане на HTML-а на lstarbg.com (OpenCart, тема Journal).
// Без мрежа и без DOM: работят еднакво в Node и в браузър, затова тестовете
// и тестовият рън минават през един и същ код.

import { parse, type HTMLElement } from "node-html-parser";

export interface ListingProduct {
  productId: string;
  url: string;
  brand: string;
  model: string;
  name: string;
  /** Цена в EUR от листинга, или null ако там няма цена. */
  priceEur: number | null;
}

export interface CategoryPage {
  name: string;
  /** Общ брой продукти според "Показани X от Y | Z (N Страници)". */
  total: number | null;
  pages: number | null;
  products: ListingProduct[];
  /** Има ли линк за изход - т.е. сесията е логната. */
  loggedIn: boolean;
}

export interface ProductPage {
  name: string;
  brand: string;
  model: string;
  /** SKU на производителя от полето "SKU:" (празно ако липсва). */
  sku: string;
  priceEur: number | null;
  /** true = "Наличен", false = изчерпан, null = неизвестно. */
  inStock: boolean | null;
  loggedIn: boolean;
  /** Снимките от галерията, в реда на сайта, в 1000×1000 (data-largeimg). */
  images: string[];
  /** Таблицата „Спецификация“: „Модел Телефон“, „Бранд“, „Марка“, „Цвят“, „Дължина“… */
  attributes: Record<string, string>;
  /** Текстът от таба „Описание“, без HTML. */
  description: string;
}

const clean = (s: string | undefined | null): string =>
  (s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

function decodeHref(href: string): string {
  return href.replace(/&amp;/g, "&");
}

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

/** Текущата цена в елемент .price: промоционалната (price-new) има приоритет. */
function priceFrom(el: HTMLElement | null): number | null {
  if (!el) return null;
  const candidate =
    el.querySelector(".price-new") ??
    el.querySelector(".price-normal") ??
    el;
  return parsePriceEur(candidate.text);
}

function isLoggedIn(root: HTMLElement): boolean {
  return root.querySelectorAll("a").some((a) =>
    /route=account\/logout/.test(a.getAttribute("href") ?? "")
  );
}

export function parseCategoryPage(html: string): CategoryPage {
  const root = parse(html);
  const name = clean(root.querySelector("#content h1, h1")?.text);

  const resultsText =
    clean(root.querySelector(".pagination-results, .results")?.text) ||
    (clean(root.text).match(/Показани[^|]*\|[^)]*\)/)?.[0] ?? "");
  const totalMatch = resultsText.match(/от\s+(\d+)/);
  const pagesMatch = resultsText.match(/\((\d+)\s+Страниц/);

  const cards = root.querySelectorAll(".main-products .product-layout");
  const products: ListingProduct[] = [];
  for (const card of cards) {
    const link = card.querySelector(".name a") ?? card.querySelector('a[href*="product_id="]');
    const href = decodeHref(link?.getAttribute("href") ?? "");
    const id = href.match(/product_id=(\d+)/)?.[1];
    if (!id) continue;
    products.push({
      productId: id,
      url: `https://lstarbg.com/index.php?route=product/product&product_id=${id}`,
      brand: clean(card.querySelector(".stat-1 a")?.text ?? card.querySelector(".stat-1 span:last-child")?.text),
      model: clean(card.querySelector(".stat-2 span:last-child")?.text),
      name: clean(card.querySelector(".name a")?.text),
      priceEur: priceFrom(card.querySelector(".price")),
    });
  }

  return {
    name,
    total: totalMatch ? Number(totalMatch[1]) : null,
    pages: pagesMatch ? Number(pagesMatch[1]) : null,
    products,
    loggedIn: isLoggedIn(root),
  };
}

function statValue(root: HTMLElement, cls: string): string {
  return clean(root.querySelector(`.product-stats .${cls} span`)?.text);
}

export function parseProductPage(html: string): ProductPage {
  const root = parse(html);
  const priceGroup = root.querySelector(".product-price-group");

  let priceEur: number | null = null;
  if (priceGroup) {
    const el =
      priceGroup.querySelector(".product-price-new") ??
      priceGroup.querySelector(".product-price");
    priceEur = parsePriceEur(el?.text);
  }

  const stock = root.querySelector(".product-stats .product-stock");
  let inStock: boolean | null = null;
  if (stock) {
    const cls = stock.getAttribute("class") ?? "";
    if (/\bin-stock\b/.test(cls)) inStock = true;
    else if (/\bout-of-stock\b/.test(cls)) inStock = false;
    else {
      const t = clean(stock.querySelector("span")?.text).toLowerCase();
      inStock = t ? /^налич/.test(t) : null;
    }
  }

  const images: string[] = [];
  for (const img of root.querySelectorAll(".product-image .main-image .swiper-slide img")) {
    const url = img.getAttribute("data-largeimg") || img.getAttribute("src") || "";
    if (/^https:\/\/lstarbg\.com\/image\//.test(url) && !images.includes(url)) images.push(url);
  }

  const attributes: Record<string, string> = {};
  for (const tr of root.querySelectorAll("#tab-specification tbody tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 2) continue;
    const key = clean(cells[0].text);
    const value = clean(cells[1].text);
    if (key && value && !(key in attributes)) attributes[key] = value;
  }

  // Темата слага случайни id-та на табовете („#product_tabs-6ad626…“), затова
  // табът се намира по надписа си „Описание“, а не по id.
  let description = "";
  const descriptionTab = root.querySelectorAll("a").find((a) =>
    /^#product_tabs-/.test(a.getAttribute("href") ?? "") && clean(a.text) === "Описание");
  const paneId = descriptionTab?.getAttribute("href")?.slice(1);
  if (paneId && /^[\w-]+$/.test(paneId)) {
    description = clean(root.querySelector(`#${paneId}`)?.text).replace(/^\.+$/, "");
  }

  return {
    images,
    attributes,
    description,
    name: clean(root.querySelector("#product h1, .product-details h1, h1")?.text),
    brand: clean(root.querySelector(".product-manufacturer span")?.text),
    model: statValue(root, "product-model"),
    sku: statValue(root, "product-sku"),
    priceEur,
    inStock,
    loggedIn: isLoggedIn(root),
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
