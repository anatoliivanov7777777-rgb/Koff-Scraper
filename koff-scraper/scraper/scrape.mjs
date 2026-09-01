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

// Прихванатите cookies, съхранени като name -> value, за да можем
// правилно да ги обединяваме между отделните заявки (сървърът връща
// сесийна бисквитка И отделна CSRF бисквитка едновременно, а обикновеният
// res.headers.get("set-cookie") в Node вижда само първата от тях).
const cookieJar = new Map();

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
  const res = await
