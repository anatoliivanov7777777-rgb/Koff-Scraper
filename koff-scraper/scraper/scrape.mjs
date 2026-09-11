// Скрейпър, който вика директно JSON API-то на shop.koff.ro.
// Няма нужда от Playwright/headless browser - сайтът е Vue SPA, но
// цялата данни идват от чисти JSON endpoint-и, които викаме директно.

import fs from "fs";
import { generateExports } from "./generate-exports.mjs";
import { calcB2BPrice, calcB2CPrice } from "./pricing.mjs";
import { mapToConvexProduct } from "./product-mapping.mjs";
import { createKoffClient } from "./koff-client.mjs";

// Папка, в която се записват готовите .xlsx файлове за импорт в case-king.bg
// (GitHub Actions ги качва като "artifact" след всеки run - виж workflow-а).
const EXPORT_OUT_DIR = process.env.EXPORT_OUT_DIR || ".";

// ---- Конфигурация от environment variables (задават се в GitHub Secrets) ----
const KOFF_EMAIL = process.env.KOFF_EMAIL;
const KOFF_PASSWORD = process.env.KOFF_PASSWORD;
const CONVEX_URL = process.env.CONVEX_HTTP_URL; // напр. https://xxxxx.convex.site/ingest-products
const SCRAPER_SECRET = process.env.SCRAPER_SECRET;
const ENABLE_KOFF_CONVEX_INGEST = process.env.ENABLE_KOFF_CONVEX_INGEST === "true";

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
  return {
    ...product,
    priceB2B: calcB2BPrice(product.basePrice),
    priceB2C: calcB2CPrice(product.basePrice),
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
    body: JSON.stringify({ products: products.map(({ stock, sourceProductId, ...product }) => product) }),
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

    // Малка пауза между заявките към категориите, за да не претоварваме
    // API-то на koff.ro и да не заприличаме на агресивен bot
    await new Promise((r) => setTimeout(r, 300));
  }

  const payload = [...productsById.values()];
  console.log(`Общо уникални продукти с валидна цена: ${payload.length}`);

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
