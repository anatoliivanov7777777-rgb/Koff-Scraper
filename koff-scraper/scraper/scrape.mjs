// Скрейпър, който вика директно JSON API-то на shop.koff.ro.
// Няма нужда от Playwright/headless browser - сайтът е Vue SPA, но
// цялата данни идват от чисти JSON endpoint-и, които викаме директно.

// ---- Конфигурация от environment variables (задават се в GitHub Secrets) ----
const KOFF_EMAIL = process.env.KOFF_EMAIL;
const KOFF_PASSWORD = process.env.KOFF_PASSWORD;
const CONVEX_URL = process.env.CONVEX_HTTP_URL; // напр. https://xxxxx.convex.site/ingest-products
const SCRAPER_SECRET = process.env.SCRAPER_SECRET;

if (!KOFF_EMAIL || !KOFF_PASSWORD || !CONVEX_URL || !SCRAPER_SECRET) {
  console.error(
    "Липсват задължителни env vars: KOFF_EMAIL, KOFF_PASSWORD, CONVEX_HTTP_URL, SCRAPER_SECRET"
  );
  process.exit(1);
}

const BASE_URL = "https://shop.koff.ro";

// Прихванатите cookies от логин отговора - пращат се с всяка следваща заявка
let sessionCookies = "";

// Малка помощна функция, която пази cookies между заявките
// (Node fetch не пази cookie jar автоматично като браузър)
async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(sessionCookies ? { Cookie: sessionCookies } : {}),
      ...options.headers,
    },
  });

  const setCookie = res.headers.get("set-cookie");
  if (setCookie) {
    sessionCookies = setCookie
      .split(/,(?=[^;]+?=)/)
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  return res;
}

async function login() {
  const res = await apiFetch("/login/enter", {
    method: "POST",
    body: JSON.stringify({
      username: KOFF_EMAIL,
      password: KOFF_PASSWORD,
    }),
  });

  if (!res.ok) {
    throw new Error(`Логинът се провали: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(`Логинът върна success:false -> ${JSON.stringify(json)}`);
  }

  console.log("Логнати успешно в koff.ro.");
}

async function getAllCategoryIds() {
  const res = await apiFetch("/api/category");
  if (!res.ok) {
    throw new Error(`Неуспешно взимане на категории: ${res.status}`);
  }
  const tree = await res.json();

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
    const res = await apiFetch(
      `/api/category/${categoryId}/products?expand=cartQty,inCart&page=${page}`
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

function mapToConvexProduct(raw) {
  const base = raw.salePrice ?? raw.basePrice;

  if (base === null || base === undefined) {
    return null;
  }

  return {
    sourceId: raw.sku || String(raw.id),
    name: raw.name,
    description: raw.description || "",
    basePrice: base,
    imageUrl: raw.coverUrl || undefined,
  };
}

async function pushToConvex(products) {
  const res = await fetch(CONVEX_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-scraper-secret": SCRAPER_SECRET,
    },
    body: JSON.stringify({ products }),
  });

  if (!res.ok) {
    throw new Error(`Convex ingest failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  console.log("Convex отговор:", json);
}

async function main() {
  await login();

  const categories = await getAllCategoryIds();
  console.log(`Намерени ${categories.length} категории (всички нива).`);

  // sourceId -> продукт, за да не дублираме продукти, които се показват
  // в няколко категории едновременно (напр. родителска + подкатегория)
  const productsById = new Map();

  for (const cat of categories) {
    const raw = await scrapeCategoryProducts(cat.id);
    console.log(`Категория "${cat.name}" (id ${cat.id}): ${raw.length} продукта`);

    for (const rawProduct of raw) {
      const mapped = mapToConvexProduct(rawProduct);
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

  const BATCH_SIZE = 200;
  for (let i = 0; i < payload.length; i += BATCH_SIZE) {
    await pushToConvex(payload.slice(i, i + BATCH_SIZE));
  }

  console.log("Готово!");
}

main().catch((err) => {
  console.error("Скрейпърът гръмна:", err);
  process.exit(1);
});
