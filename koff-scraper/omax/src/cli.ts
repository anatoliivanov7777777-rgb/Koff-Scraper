// Сваляне от b2b.omax.bg → out/omax-products.json
//
//   OMAX_EMAIL=... OMAX_PASSWORD=... npm run scrape
//
// Env:
//   OMAX_EMAIL / OMAX_PASSWORD   входът на магазина (GitHub Secrets)
//   OUT_DIR                      по подразбиране out/
//   STATE_DIR                    кешът на продуктовите страници (по подразбиране state/)
//   DETAIL_CAP                   колко продуктови страници най-много на пускане (по подразбиране 1500)
//   DETAIL_MAX_AGE_DAYS          след колко дни продуктова страница се чете наново (по подразбиране 30)
//
// Пести заявки към Omax: списъците (60 продукта на страница) се обхождат
// всеки път, а продуктовата страница (EAN, снимки, описание) - само за нов
// продукт или когато кешът е стар. Изчерпаните са накрая на списъка, затова
// обхождането на категория спира на първата страница с изчерпан продукт.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { selectCategories, type CategoryToScrape } from "./categories.js";
import { createOmaxClient, type OmaxClient } from "./client.js";
import { parseDetail, parseListing, parseMenu, type ListingItem } from "./parse.js";
import type { ScrapedProduct } from "./shop-row.js";

export interface DetailCacheEntry { ean: string; images: string[]; description: string; fetchedAt: string }
export type DetailCache = Record<string, DetailCacheEntry>;

export interface ScrapeOutput {
  scrapedAt: string;
  categories: number;
  listed: number;
  inStock: number;
  /** Налични, чиято продуктова страница още не е прочетена (лимитът) - не се нулират. */
  deferred: number[];
  products: ScrapedProduct[];
  skippedCategories: string[];
  requests: number;
}

const MAX_PAGES_PER_CATEGORY = 100;

export function pageUrl(href: string, page: number): string {
  const base = href.replace(/\/+$/, "");
  return page <= 1 ? `${base}/` : `${base}/${page}`;
}

/** Наличните продукти на една категория (спира на първата страница с изчерпан). */
export async function listCategory(client: Pick<OmaxClient, "fetchSignedIn">, category: CategoryToScrape) {
  const items: ListingItem[] = [];
  let listed = 0;
  for (let page = 1; page <= MAX_PAGES_PER_CATEGORY; page++) {
    const { items: pageItems, lastPage } = parseListing(await client.fetchSignedIn(pageUrl(category.href, page)));
    listed += pageItems.length;
    items.push(...pageItems.filter((i) => i.inStock));
    if (pageItems.some((i) => !i.inStock) || page >= lastPage || pageItems.length === 0) break;
  }
  return { items, listed };
}

export function needsDetail(entry: DetailCacheEntry | undefined, now: number, maxAgeDays: number): boolean {
  if (!entry) return true;
  const age = now - Date.parse(entry.fetchedAt);
  return !Number.isFinite(age) || age > maxAgeDays * 86_400_000;
}

export async function scrape(client: Pick<OmaxClient, "fetchSignedIn">, cache: DetailCache, options: { detailCap: number; maxAgeDays: number; log?: (m: string) => void }) {
  const log = options.log ?? (() => {});
  const menu = parseMenu(await client.fetchSignedIn("/bg/"));
  const { selected, skipped } = selectCategories(menu);
  if (!selected.length) throw new Error("Omax: в менюто няма нито една от избраните категории - сайтът може да е сменен");
  log(`Категории: ${selected.length} за обхождане, ${skipped.length} изключени`);

  const found = new Map<number, { item: ListingItem; category: CategoryToScrape }>();
  let listed = 0;
  for (const category of selected) {
    const res = await listCategory(client, category);
    listed += res.listed;
    for (const item of res.items) if (!found.has(item.productId)) found.set(item.productId, { item, category });
  }
  log(`Списъци: ${listed} реда, ${found.size} налични продукта`);

  const now = Date.now();
  // Първо новите (без кеш), после най-старите - до лимита.
  const queue = [...found.keys()]
    .filter((id) => needsDetail(cache[id], now, options.maxAgeDays))
    .sort((a, b) => (cache[a] ? Date.parse(cache[a].fetchedAt) : 0) - (cache[b] ? Date.parse(cache[b].fetchedAt) : 0));
  let read = 0;
  for (const id of queue.slice(0, options.detailCap)) {
    const { item } = found.get(id)!;
    try {
      const detail = parseDetail(await client.fetchSignedIn(item.href));
      cache[id] = { ean: detail.ean, images: detail.images, description: detail.description, fetchedAt: new Date().toISOString() };
      read++;
    } catch (error) {
      log(`Продукт ${id}: страницата не се прочете (${error instanceof Error ? error.message : error})`);
    }
  }
  log(`Продуктови страници: ${read} прочетени, ${Math.max(0, queue.length - options.detailCap)} отложени за следващия път`);

  const products: ScrapedProduct[] = [];
  const deferred: number[] = [];
  for (const [id, { item, category }] of found) {
    const detail = cache[id];
    if (!detail) { deferred.push(id); continue; }
    products.push({
      productId: id,
      name: item.name,
      href: item.href,
      priceEur: item.priceEur ?? 0,
      kind: category.kind,
      categoryPath: category.path,
      ean: detail.ean,
      images: detail.images,
      description: detail.description,
    });
  }
  return { products, deferred, listed, categories: selected.length, skipped };
}

function readJson<T>(file: string, fallback: T): T {
  try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback; } catch { return fallback; }
}

async function main() {
  const outDir = process.env.OUT_DIR || "out";
  const stateDir = process.env.STATE_DIR || "state";
  const cacheFile = join(stateDir, "omax-details.json");
  const cache = readJson<DetailCache>(cacheFile, {});
  const client = createOmaxClient({
    email: process.env.OMAX_EMAIL ?? "",
    password: process.env.OMAX_PASSWORD ?? "",
    log: console.log,
  });
  await client.login();
  const result = await scrape(client, cache, {
    detailCap: Number(process.env.DETAIL_CAP) || 1500,
    maxAgeDays: Number(process.env.DETAIL_MAX_AGE_DAYS) || 30,
    log: console.log,
  });
  // Кешът пази само продуктите, които още са в списъците (иначе расте вечно).
  const live = new Set([...result.products.map((p) => String(p.productId))]);
  const pruned: DetailCache = Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(pruned));

  const output: ScrapeOutput = {
    scrapedAt: new Date().toISOString(),
    categories: result.categories,
    listed: result.listed,
    inStock: result.products.length + result.deferred.length,
    deferred: result.deferred,
    products: result.products,
    skippedCategories: result.skipped,
    requests: client.getCounters().requests,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "omax-products.json"), JSON.stringify(output, null, 2));
  console.log(`Готово: ${output.products.length} продукта (+${output.deferred.length} отложени), ${output.requests} заявки → ${join(outDir, "omax-products.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("Omax свалянето спря:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
