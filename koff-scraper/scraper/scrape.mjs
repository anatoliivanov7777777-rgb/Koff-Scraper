// Скрейпър, който вика директно JSON API-то на shop.koff.ro.
// Няма нужда от Playwright/headless browser - сайтът е Vue SPA, но
// цялата данни идват от чисти JSON endpoint-и, които викаме директно.

import fs from "fs";
import { generateExports } from "./generate-exports.mjs";
import { addVat, calcB2BPrice, calcB2CPrice } from "./pricing.mjs";
import { mapToConvexProduct } from "./product-mapping.mjs";
import { createKoffClient } from "./koff-client.mjs";
import { fetchGalleriesBounded } from "./product-gallery.mjs";

// Папка, в която се записват готовите .xlsx файлове за импорт в case-king.bg
// (GitHub Actions ги качва като "artifact" след всеки run - виж workflow-а).
const EXPORT_OUT_DIR = process.env.EXPORT_OUT_DIR || ".";

// ---- Конфигурация от environment variables (задават се в GitHub Secrets) ----
const KOFF_EMAIL = process.env.KOFF_EMAIL;
const KOFF_PASSWORD = process.env.KOFF_PASSWORD;
const CONVEX_URL = process.env.CONVEX_HTTP_URL; // напр. https://xxxxx.convex.site/ingest-products
const SCRAPER_SECRET = process.env.SCRAPER_SECRET;
const ENABLE_KOFF_CONVEX_INGEST = process.env.ENABLE_KOFF_CONVEX_INGEST === "true";

// Off by default in code - the caller (e.g. sync-caseking.yml) opts in
// explicitly. The /api/product/:id?expand=...,images,... gallery source is
// fully verified: statically (decompiled from koff.ro's own frontend, see
// product-gallery.mjs) and live end-to-end (2026-09-16, authenticated,
// read-only, 3 real products through this exact scrape.mjs code path -
// correct cover-first/https-only/deduplicated ordering for all three). Even
// so, an unrecognized/failed response for any individual product still
// degrades safely to today's single-cover-image behavior for that product,
// never to a missing/empty image.
const ENABLE_GALLERY_FETCH = process.env.ENABLE_GALLERY_FETCH === "true";
const rawGalleryConcurrency = Number.parseInt(process.env.GALLERY_FETCH_CONCURRENCY ?? "", 10);
const GALLERY_FETCH_CONCURRENCY = Number.isInteger(rawGalleryConcurrency) && rawGalleryConcurrency > 0
  ? Math.min(rawGalleryConcurrency, 20)
  : 5;

if (!KOFF_EMAIL || !KOFF_PASSWORD) {
  console.error("Липсват задължителни env vars: KOFF_EMAIL, KOFF_PASSWORD");
  process.exit(1);
}
if (ENABLE_KOFF_CONVEX_INGEST && (!CONVEX_URL || !SCRAPER_SECRET)) {
  console.error("ENABLE_KOFF_CONVEX_INGEST изисква CONVEX_HTTP_URL и SCRAPER_SECRET");
  process.exit(1);
}

const koffClient = createKoffClient({ email: KOFF_EMAIL, password: KOFF_PASSWORD });

async function getAllCategoryIds() {
  const res = await koffClient.request(`/api/category?_=${Date.now()}`);
  if (!res.ok) {
    throw new Error(`Неуспешно взимане на категории: ${res.status}`);
  }
  const tree = await res.json();

  console.log(
    "Суров отговор от /api/category (тип и дължина):",
    Array.isArray(tree) ? `масив с ${tree.length} елемента` : typeof tree
  );
  if (!Array.isArray(tree) || tree.length === 0) {
    console.log("Пълен суров отговор:", JSON.stringify(tree).slice(0, 500));
  }

  const ids = [];
  function walk(nodes) {
    for (const node of nodes) {
      ids.push({ id: node.id, name: node.name });
      if (node.children && node.children.length > 0) {
        walk(node.children);
      }
    }
  }
  walk(tree);
  return ids;
}

async function scrapeCategoryProducts(categoryId) {
  const products = [];
  let page = 1;

  while (true) {
    const res = await koffClient.request(
      `/api/category/${categoryId}/products?expand=cartQty,inCart&page=${page}&_=${Date.now()}`
    );

    if (!res.ok) {
      console.warn(
        `Категория ${categoryId}, стр. ${page}: HTTP ${res.status} - прескачам`
      );
      break;
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    products.push(...batch);
    page += 1;

    if (page > 200) {
      console.warn(`Категория ${categoryId}: спирам на страница 200 (предпазна спирачка)`);
      break;
    }
  }

  return products;
}

// Отделна версия САМО за Excel export-а (с изчислени цени) - НЕ се праща
// към Convex, защото Convex стриктно отхвърля обекти с неочаквани полета.
function withDisplayPrices(product) {
  // Koff prices are net of VAT. Keep exports identical to the real CaseKing
  // sync: add 20% VAT first, then apply the B2B/B2C markup rules and .99 rounding.
  const baseWithVat = addVat(product.basePrice);
  return {
    ...product,
    priceB2B: calcB2BPrice(baseWithVat),
    priceB2C: calcB2CPrice(baseWithVat),
  };
}

async function pushToConvex(products) {
  const res = await fetch(CONVEX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-scraper-secret": SCRAPER_SECRET,
    },
    // The optional legacy Koff Convex schema has neither the CaseKing stock
    // field nor sourceProductId.
    body: JSON.stringify({
      products: products.map(({ stock, sourceProductId, max, isEol, ...product }) => product),
    }),
  });

  if (!res.ok) {
    throw new Error(`Convex ingest failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  console.log(`Партида качена: ${json.received} продукта`);
}

async function pushCategories(categoryNames) {
  const res = await fetch(CONVEX_URL.replace("/ingest-products", "/ingest-categories"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-scraper-secret": SCRAPER_SECRET,
    },
    body: JSON.stringify({ categories: categoryNames }),
  });

  if (!res.ok) {
    throw new Error(`Ingest categories failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  console.log(`Категории качени: ${json.count}`);
}

async function finalizeIngest(cutoffTimestamp) {
  let mayHaveMore = true;
  let totalDeactivated = 0;

  while (mayHaveMore) {
    const res = await fetch(CONVEX_URL.replace("/ingest-products", "/finalize-ingest"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-scraper-secret": SCRAPER_SECRET,
      },
      body: JSON.stringify({ cutoffTimestamp }),
    });

    if (!res.ok) {
      throw new Error(`Finalize failed: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    totalDeactivated += json.deactivated;
    mayHaveMore = json.mayHaveMore;
    console.log(`Деактивирани дотук: ${totalDeactivated}`);
  }

  return totalDeactivated;
}

async function main() {
  const runStartedAt = Date.now();

  await koffClient.login();
  await koffClient.ensureFreshToken();

  const categories = await getAllCategoryIds();
  console.log(`Намерени ${categories.length} категории (всички нива).`);

  const uniqueCategoryNames = [...new Set(categories.map((c) => c.name))];

  // sourceId -> продукт, за да не дублираме продукти, които се показват
  // в няколко категории едновременно (напр. родителска + подкатегория)
  const productsById = new Map();

  for (const cat of categories) {
    await koffClient.ensureFreshToken();
    const raw = await scrapeCategoryProducts(cat.id);
    console.log(`Категория "${cat.name}" (id ${cat.id}): ${raw.length} продукта`);

    for (const rawProduct of raw) {
      const mapped = mapToConvexProduct(rawProduct, cat.name);
      if (mapped) {
        productsById.set(mapped.sourceId, mapped);
      }
    }

    // No sleep here on purpose. The old 300ms category pause is now redundant:
    // every outbound call goes through the client's shared 500ms start-slot
    // pacing (koff-client.mjs), which already spaces the category crawl - and
    // unlike a per-category sleep it also covers the gallery pool. Stacking
    // both would just double the delay without making the crawl any politer.
  }

  const payload = [...productsById.values()];
  console.log(`Общо уникални продукти с валидна цена: ${payload.length}`);

  // Additive, opt-in gallery enrichment: ONE bounded-concurrency pass over
  // the already-deduplicated product set (never per-category, never
  // unbounded Promise.all over the whole catalog - see product-gallery.mjs).
  //
  // CRITICAL: `product.images` is set ONLY when the detail fetch actually
  // SUCCEEDED (result.ok === true), never merely because a gallery is
  // empty/missing. A failed/errored detail request leaves `images`
  // completely unset on this product, even though `imageUrl` (the cover,
  // from the catalog list response) is always already present - so
  // sync-caseking.mjs can tell "Koff explicitly confirmed this gallery"
  // apart from "gallery fetch failed this run" and never sends CaseKing an
  // `images:[cover]` overwrite that would erase an existing multi-image
  // gallery just because this one run's detail request errored out.
  if (ENABLE_GALLERY_FETCH) {
    const idsToFetch = payload
      .map((product) => product.sourceProductId)
      .filter((id) => Number.isInteger(id) && id > 0);
    console.log(
      `Извличам допълнителна галерия за ${idsToFetch.length} продукта ` +
        `(concurrency ${GALLERY_FETCH_CONCURRENCY})...`
    );
    const { galleries, counters, abortedForAuthorization } = await fetchGalleriesBounded(
      koffClient,
      idsToFetch,
      { concurrency: GALLERY_FETCH_CONCURRENCY }
    );
    console.log(
      `Галерии: опитани ${counters.attempted}, успешни ${counters.succeeded}, ` +
        `неуспешни ${counters.failed}, общо намерени снимки ${counters.totalImagesFound}`
    );
    if (abortedForAuthorization) {
      console.error(
        "Галериите са прекъснати: Koff върна 401/403. Продуктите без галерия остават без промяна."
      );
    }
    for (const product of payload) {
      const result = galleries.get(product.sourceProductId);
      if (result?.ok) product.images = result.images;
    }
  }

  // Per-run request telemetry. Counters only - no URLs, no credentials.
  const requestCounters = koffClient.getRequestCounters();
  console.log(
    `Заявки: общо ${requestCounters.requests}, повторения ${requestCounters.retries}, ` +
      `HTTP 429 ${requestCounters.http429}, временни 5xx ${requestCounters.transient5xx}, ` +
      `откази за достъп ${requestCounters.authFailures}`
  );

  console.log("Генерирам Excel файлове за импорт в case-king.bg...");
  const withPrices = payload.map(withDisplayPrices);
  generateExports(withPrices, EXPORT_OUT_DIR);

  console.log("Записвам суровите продукти в koff-products-raw.json...");
  fs.writeFileSync(
    `${EXPORT_OUT_DIR}/koff-products-raw.json`,
    JSON.stringify(payload)
  );

  // The CaseKing workflow consumes the local JSON directly. The old Koff
  // Convex mirror is optional and uses its own, separate SCRAPER_SECRET.
  if (ENABLE_KOFF_CONVEX_INGEST) {
    await pushCategories(uniqueCategoryNames);
    const BATCH_SIZE = 200;
    for (let i = 0; i < payload.length; i += BATCH_SIZE) {
      await pushToConvex(payload.slice(i, i + BATCH_SIZE));
    }
    console.log("Всички партиди изпратени. Деактивирам остарели продукти...");
    const deactivated = await finalizeIngest(runStartedAt);
    console.log(`Общо деактивирани: ${deactivated}`);
  }

  console.log("Готово!");
}

main().catch((err) => {
  console.error("Скрейпърът гръмна:", err);
  process.exit(1);
});
