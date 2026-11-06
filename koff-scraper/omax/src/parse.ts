// Четене на страниците на b2b.omax.bg (2026-11-05).
//
// Сайтът е класически сървърно рендериран (jQuery + Bootstrap), без API:
//   - мега-менюто е на всяка страница: li.dropdown-submenu > a (корен) и
//     колони ul.menu-column, където <li> с <b> е подкатегория (ниво 2), а
//     следващите li.megasub са нейните листа (ниво 3);
//   - категорията /bg/products/<id>/<име>/ показва по 60 продукта на ред
//     div.row-stripedd; страниците са /products/<id>/<име>/<N>; страница от
//     ниво 2 събира и продуктите на листата си, коренът не показва продукти;
//   - изчерпаните са накрая: без цена, без бутон за количка, с етикет
//     "out of stock";
//   - продуктовата страница дава EAN (itemprop="gtin13"), всички снимки
//     (a.main-pics) и описанието (itemprop="description").
// Цените са в EUR и С ДДС ("Посочените цени в сайта са с включено ДДС").

import { parse, type HTMLElement } from "node-html-parser";

export const BASE_URL = "https://b2b.omax.bg";

export interface MenuNode {
  id: number;
  name: string;
  href: string;
  children: MenuNode[];
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();
// "Протектори hot", "HOCO new" - етикетите в менюто не са част от името.
const menuName = (text: string) => clean(text).replace(/\s+(hot|new)$/i, "");

export function categoryIdOf(href: string): number | null {
  const m = /\/products\/(\d+)\//.exec(decodeURIComponent(href));
  return m ? Number(m[1]) : null;
}

/** Корените на мега-менюто с подкатегориите (ниво 2) и листата им (ниво 3). */
export function parseMenu(html: string): MenuNode[] {
  const root = parse(html);
  const roots: MenuNode[] = [];
  const seen = new Set<number>();
  for (const li of root.querySelectorAll("li.dropdown-submenu")) {
    const a = li.querySelector(":scope > a") ?? li.querySelector("a");
    if (!a) continue;
    const href = a.getAttribute("href") ?? "";
    const id = categoryIdOf(href);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    const node: MenuNode = { id, name: menuName(a.text), href, children: [] };
    for (const column of li.querySelectorAll("ul.menu-column")) {
      let current: MenuNode | null = null;
      for (const item of column.querySelectorAll(":scope > li")) {
        const link = item.querySelector("a");
        if (!link) continue;
        const itemHref = link.getAttribute("href") ?? "";
        const itemId = categoryIdOf(itemHref);
        if (itemId === null) continue;
        const entry: MenuNode = { id: itemId, name: menuName(link.text), href: itemHref, children: [] };
        if (link.querySelector("b") || !item.classList.contains("megasub")) {
          current = entry;
          node.children.push(entry);
        } else if (current) {
          current.children.push(entry);
        } else {
          node.children.push(entry);
        }
      }
    }
    roots.push(node);
  }
  return roots;
}

export interface ListingItem {
  productId: number;
  name: string;
  href: string;
  priceEur: number | null;
  inStock: boolean;
  thumb: string;
  labels: string[];
}

export function parsePrice(text: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*EUR/i.exec(text.replace(/\s+/g, " "));
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function parseListing(html: string): { items: ListingItem[]; lastPage: number } {
  const root = parse(html);
  const items: ListingItem[] = [];
  for (const row of root.querySelectorAll("div.row-stripedd")) {
    const link = row.querySelector("a[href*='/product/']");
    if (!link) continue;
    const href = link.getAttribute("href") ?? "";
    const m = /\/product\/(\d+)\//.exec(href);
    if (!m) continue;
    const cols = row.querySelectorAll(":scope > div");
    const priceCol = cols.find((c) => /EUR/i.test(c.text));
    const priceEur = priceCol ? parsePrice(priceCol.text) : null;
    const soldOut = Boolean(row.querySelector(".sold-out, .label-sold")) || /out of stock/i.test(row.text);
    const canBuy = Boolean(row.querySelector(".addToCart"));
    const img = link.querySelector("img.product-thumb");
    items.push({
      productId: Number(m[1]),
      name: clean(img?.getAttribute("alt") || link.text),
      href,
      priceEur,
      inStock: canBuy && !soldOut && priceEur !== null,
      thumb: img?.getAttribute("src") ?? "",
      labels: link.querySelectorAll("img.label-rotate").map((i) => (i.getAttribute("src") ?? "").split("/").pop()?.replace(/\.\w+$/, "") ?? ""),
    });
  }
  let lastPage = 1;
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    const p = /^\/products\/\d+\/[^/]+\/(\d+)$/.exec(decodeURIComponent(href));
    if (p) lastPage = Math.max(lastPage, Number(p[1]));
  }
  return { items, lastPage };
}

export interface ProductDetail {
  ean: string;
  images: string[];
  description: string;
  internalSku: string;
  inStock: boolean;
}

const EAN_RE = /^\d{8}$|^\d{12,14}$/;

function textWithBreaks(el: HTMLElement | null): string {
  if (!el) return "";
  const html = el.innerHTML.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return parse(`<div>${html}</div>`).text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

export function parseDetail(html: string): ProductDetail {
  const root = parse(html);
  const gtin = clean(root.querySelector("[itemprop=gtin13]")?.text ?? "");
  const images: string[] = [];
  for (const a of root.querySelectorAll("a.main-pics, .productFoto a")) {
    const href = a.getAttribute("href") ?? "";
    if (/\/images\/products\//.test(href) && !images.includes(href)) images.push(href);
  }
  if (!images.length) {
    for (const img of root.querySelectorAll("img.product-photo")) {
      const src = img.getAttribute("src") ?? "";
      if (/\/images\/products\//.test(src) && !images.includes(src)) images.push(src);
    }
  }
  const availability = root.querySelector("[itemprop=availability]")?.getAttribute("href") ?? "";
  return {
    ean: EAN_RE.test(gtin) ? gtin : "",
    images,
    description: textWithBreaks(root.querySelector("[itemprop=description]")),
    internalSku: root.querySelector("meta[itemprop=sku]")?.getAttribute("content") ?? "",
    inStock: /InStock/i.test(availability),
  };
}

/** Логнатият клиент има връзка "Изход" (/bg/login/logout/); нелогнатият - "Влез".
 * Скрейпърът никога не отваря тази връзка - само я търси в страницата. */
export function looksLoggedOut(html: string): boolean {
  return !/\/login\/logout\//.test(html);
}
