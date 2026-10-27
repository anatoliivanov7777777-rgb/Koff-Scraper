// Koff through a real browser (owner, 2026-10-27).
//
// Since 2026-10-27 shop.koff.ro sits behind a Cloudflare check that answers
// every non-browser client with HTTP 403 ("Just a moment..."), from GitHub's
// servers and from the owner's own home connection alike. Koff told the owner
// to carry on by his own means. A normal Chrome window on the owner's computer
// passes the check by itself, with no click and nothing faked, so this module
// sends the client's requests from inside such a window.
//
// What it does NOT do: it does not solve or spoof any challenge, does not use
// "stealth" patches, does not copy cookies out of the owner's own browser and
// does not run headless (headless Chrome is still challenged - tested
// 2026-10-27 - and making it pass would mean disguising it). If Cloudflare ever
// asks for an interactive check, the run stops with a clear message instead.
//
// The window is opened only on the first Koff request (a drain run with an
// empty queue never opens it) and is placed off-screen so it does not get in
// the owner's way.
//
// The returned function has the fetch() shape koff-client.mjs expects. Cookies
// are kept by the browser itself, so the client's own cookie jar simply stays
// empty; the Cookie header it would set is dropped here (a page cannot set it).

const DEFAULT_BASE_URL = "https://shop.koff.ro";
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_CHANNELS = ["chrome", "msedge"];
const DROPPED_REQUEST_HEADERS = new Set(["cookie", "host", "content-length", "connection"]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export class KoffBrowserError extends Error {}

export function isBrowserFetchEnabled(env = process.env) {
  return String(env.KOFF_BROWSER || "").toLowerCase() === "true";
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === "function" && !(Array.isArray(headers))
    ? headers.entries()
    : Object.entries(headers);
  for (const [name, value] of entries) {
    if (DROPPED_REQUEST_HEADERS.has(String(name).toLowerCase())) continue;
    out[name] = String(value);
  }
  return out;
}

// Runs inside the page. Kept free of closures: Playwright serialises it.
async function pageFetch({ path, method, headers, body }) {
  try {
    const response = await fetch(path, { method, headers, body, credentials: "same-origin", redirect: "follow" });
    const responseHeaders = [];
    response.headers.forEach((value, name) => responseHeaders.push([name, value]));
    const text = await response.text();
    return { ok: true, status: response.status, statusText: response.statusText, headers: responseHeaders, text };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function defaultLaunch({ channel, args }) {
  let playwright;
  try {
    playwright = await import("playwright-core");
  } catch {
    throw new KoffBrowserError(
      "KOFF_BROWSER=true needs the playwright-core package (npm install in koff-scraper/scraper)"
    );
  }
  return playwright.chromium.launch({ channel, headless: false, args });
}

export function createBrowserFetch({
  baseUrl = DEFAULT_BASE_URL,
  channels = DEFAULT_CHANNELS,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  launch = defaultLaunch,
  logger = console,
} = {}) {
  const origin = new URL(baseUrl).origin;
  let browser = null;
  let page = null;
  let opening = null;

  async function open() {
    const args = ["--window-position=-2400,-2400", "--window-size=1000,700"];
    let lastError = null;
    for (const channel of channels) {
      try {
        browser = await launch({ channel, args });
        logger.info?.(`Koff: отворих браузър (${channel}) за заявките към Koff`);
        break;
      } catch (error) {
        if (error instanceof KoffBrowserError) throw error;
        lastError = error;
      }
    }
    if (!browser) {
      throw new KoffBrowserError(
        `Не успях да отворя Chrome или Edge за Koff: ${lastError?.message?.split("\n")[0] ?? "няма браузър"}`
      );
    }
    page = await browser.newPage();
    await page.goto(`${origin}/en`, { waitUntil: "domcontentloaded", timeout: readyTimeoutMs });
    try {
      // The shop's own page carries this tag; the Cloudflare check page does not.
      await page.waitForSelector('meta[name="csrf-token"]', { state: "attached", timeout: readyTimeoutMs });
    } catch {
      const title = await page.title().catch(() => "");
      throw new KoffBrowserError(
        `Koff не пусна браузъра до магазина (страница: "${title}"). ` +
          "Ако Cloudflare иска ръчна проверка, отвори shop.koff.ro в Chrome и я мини, после пусни отново."
      );
    }
  }

  async function ensureOpen() {
    if (page) return;
    if (!opening) opening = open().catch((error) => { opening = null; throw error; });
    await opening;
  }

  async function browserFetch(url, init = {}) {
    const target = new URL(String(url), origin);
    if (target.origin !== origin) {
      throw new KoffBrowserError("The Koff browser only sends requests to the Koff shop");
    }
    await ensureOpen();
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    const result = await page.evaluate(pageFetch, {
      path: target.pathname + target.search,
      method,
      headers: headersToObject(init.headers),
      body,
    });
    if (!result.ok) {
      // Same shape as a dropped connection, so the client's network-retry
      // policy for reads applies unchanged.
      const error = new TypeError(`fetch failed (browser): ${result.error}`);
      error.cause = { code: "ECONNRESET" };
      throw error;
    }
    const responseBody = NULL_BODY_STATUSES.has(result.status) ? null : result.text;
    return new Response(responseBody, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }

  async function close() {
    const current = browser;
    browser = null;
    page = null;
    opening = null;
    if (current) await current.close().catch(() => {});
  }

  return { fetch: browserFetch, close };
}

// The one switch every entry point uses: KOFF_BROWSER=true -> the browser,
// anything else -> plain fetch exactly as before.
export function resolveKoffFetch({ env = process.env, ...options } = {}) {
  if (!isBrowserFetchEnabled(env)) {
    return { fetch: globalThis.fetch, close: async () => {}, usesBrowser: false };
  }
  const browserFetch = createBrowserFetch(options);
  return { ...browserFetch, usesBrowser: true };
}
