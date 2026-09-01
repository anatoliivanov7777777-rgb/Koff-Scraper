// Скрейпър, който вика директно JSON API-то на shop.koff.ro.
// Няма нужда от Playwright/headless browser - сайтът е Vue SPA, но
// цялата данни идват от чисти JSON endpoint-и, които викаме директно.

import { generateExports } from "./generate-exports.mjs";

// Папка, в която се записват готовите .xlsx файлове за импорт в case-king.bg
// (GitHub Actions ги качва като "artifact" след всеки run - виж workflow-а).
const EXPORT_OUT_DIR = process.env.EXPORT_OUT_DIR || ".";

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

// Прихванатите cookies, съхранени като name -> value, за да можем
// правилно да ги обединяваме между отделните заявки (сървърът връща
// сесийна бисквитка И отделна CSRF бисквитка едновременно, а обикновеният
// res.headers.get("set-cookie") в Node вижда само първата от тях).
const cookieJar = new Map();

// JWT access token, взет от /login/refresh - трябва да се праща като
// "Authorization: Bearer ..." на всяка заявка към /api/*. Обикновената
// сесийна бисквитка НЕ е достатъчна за тези ендпойнти - затова получавахме
// празни резултати преди тази поправка.
let accessToken = null;
let tokenIssuedAt = 0;
const TOKEN_MAX_AGE_MS = 8 * 60 * 1000; // опресняваме на всеки 8 мин (токенът тае за 10)

// Пазим последния взет CSRF токен глобално - и /login/enter, И /login/refresh
// (и вероятно всяка друга POST заявка) го изискват в X-Csrf-Token header-а.
let lastCsrfToken = null;

function cookieHeaderString() {
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function apiFetch(path, options = {}) {
  const cookieHeader = cookieHeaderString();

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // Сайтът проверява тази версия и отхвърля заявки без нея с грешка
      // "incompatible version of the application" - взето директно от
      // headers-ите на реален браузър.
      "X-App-Version": "0.9.78",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...options.headers,
    },
  });

  // getSetCookie() връща ВСИЧКИ Set-Cookie хедъри поотделно (Node 18.14+).
  // Правим fallback към get() за по-стари версии, но той вижда само една.
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
      ? [res.headers.get("set-cookie")]
      : [];

  for (const raw of setCookies) {
    const pair = raw.split(";")[0];
    const eqIndex = pair.indexOf("=");
    if (eqIndex > -1) {
      cookieJar.set(pair.slice(0, eqIndex), pair.slice(eqIndex + 1));
    }
  }

  return res;
}

async function getCsrfToken() {
  // Сайтът е Yii2 (PHP framework) и изисква CSRF токен преди приемане на
  // POST заявки. Токенът се взима от <meta name="csrf-token"> на всяка
  // обикновена страница, а придружаващата сесийна бисквитка се задава
  // автоматично от сървъра при тази GET заявка.
  //
  // Добавяме случаен query параметър, за да "разбием" евентуален
  // Cloudflare/CDN кеш на страницата - ако получим кеширана версия на
  // страницата, тя няма да носи свежа Set-Cookie бисквитка и токенът ще
  // бъде невалиден за нашата собствена сесия.
  const res = await apiFetch(`/en?_=${Date.now()}`);
  const html = await res.text();

  const match = html.match(
    /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i
  );

  if (!match) {
    throw new Error(
      "Не успях да намеря CSRF токен на страницата - HTML структурата на сайта вероятно се е променила."
    );
  }

  return match[1];
}

async function login() {
  const csrfToken = await getCsrfToken();
  lastCsrfToken = csrfToken;
  console.log("CSRF токен взет:", csrfToken.slice(0, 20) + "...");
  console.log("Бисквитки след взимане на CSRF:", [...cookieJar.keys()].join(", "));

  const res = await apiFetch("/login/enter", {
    method: "POST",
    headers: {
      "X-Csrf-Token": csrfToken,
      "X-Requested-With": "XMLHttpRequest",
    },
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

async function refreshAccessToken() {
  const res = await apiFetch("/login/refresh", {
    method: "POST",
    headers: {
      "X-Csrf-Token": lastCsrfToken,
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Неуспешно взимане на access token: ${res.status} ${await res.text()}`
    );
  }

  const json = await res.json();
  if (!json.accessToken) {
    throw new Error(`/login/refresh не върна accessToken -> ${JSON.stringify(json)}`);
  }

  accessToken = json.accessToken;
  tokenIssuedAt = Date.now();
  console.log("Access token взет успешно (roles:", (json.roles || []).join(", ") + ")");
}

async function ensureFreshToken() {
  if (Date.now() - tokenIssuedAt > TOKEN_MAX_AGE_MS) {
    console.log("Access token е стар - опреснявам...");
    await refreshAccessToken();
  }
}

async function getAllCategoryIds() {
  const res = await apiFetch(`/api/category?_=${Date.now()}`);
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
    const res = await apiFetch(
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

// Трябва да съвпадат ТОЧНО с B2B_MARKUP/B2C_MARKUP в convex/products.ts
const B2B_MARKUP = 1.6;
const B2C_MARKUP = 1.8;

function mapToConvexProduct(raw, categoryName) {
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
    category: categoryName,
    manufacturer: raw.manufacturer?.name || undefined,
  };
}

// Отделна версия САМО за Excel export-а (с изчислени цени) - НЕ се праща
// към Convex, защото Convex стриктно отхвърля обекти с неочаквани полета.
function withDisplayPrices(product) {
  return {
    ...product,
    priceB2B: Math.round(product.basePrice * B2B_MARKUP * 100) / 100,
    priceB2C: Math.round(product.basePrice * B2C_MARKUP * 100) / 100,
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

  await login();
  await refreshAccessToken();

  const categories = await getAllCategoryIds();
  console.log(`Намерени ${categories.length} категории (всички нива).`);

  const uniqueCategoryNames = [...new Set(categories.map((c) => c.name))];
  await pushCategories(uniqueCategoryNames);

  // sourceId -> продукт, за да не дублираме продукти, които се показват
  // в няколко категории едновременно (напр. родителска + подкатегория)
  const productsById = new Map();

  for (const cat of categories) {
    await ensureFreshToken();
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

  const BATCH_SIZE = 200;
  for (let i = 0; i < payload.length; i += BATCH_SIZE) {
    await pushToConvex(payload.slice(i, i + BATCH_SIZE));
  }

  console.log("Всички партиди изпратени. Деактивирам остарели продукти...");
  const deactivated = await finalizeIngest(runStartedAt);
  console.log(`Общо деактивирани: ${deactivated}`);

  console.log("Генерирам Excel файлове за импорт в case-king.bg...");
  const withPrices = payload.map(withDisplayPrices);
  generateExports(withPrices, EXPORT_OUT_DIR);

  console.log("Готово!");
}

main().catch((err) => {
  console.error("Скрейпърът гръмна:", err);
  process.exit(1);
});
