// Сесиен HTTP клиент за lstarbg.com. Същата политика като Koff клиента:
// фиксирана пауза между заявките, повторение само на GET при 429/502/503/504
// или скъсана връзка, спиране при 401/403. Без ротация на IP/UA, без
// заобикаляне на защити. Паролата и бисквитките никога не се логват.

const BASE_URL = "https://lstarbg.com";
const USER_AGENT = "CaseKing-catalog-sync/1.0 (+https://case-king.bg)";
const DEFAULT_INTERVAL_MS = 700;
const RETRYABLE = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export interface LstarClientOptions {
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createLstarClient(options: LstarClientOptions) {
  const {
    email,
    password,
    fetchImpl = globalThis.fetch,
    minIntervalMs = DEFAULT_INTERVAL_MS,
    sleep = defaultSleep,
    log = () => {},
  } = options;
  if (!email?.trim()) throw new Error("LSTAR_EMAIL е задължителен");
  if (!password?.trim()) throw new Error("LSTAR_PASSWORD е задължителен");

  const jar = new Map<string, string>();
  let lastStart = 0;
  const counters = { requests: 0, retries: 0 };

  function storeCookies(headers: Headers) {
    const list = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie") ? [headers.get("set-cookie") as string] : [];
    for (const raw of list) {
      const pair = raw.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async function pace() {
    const wait = lastStart + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  }

  async function send(url: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    if (!url.startsWith(BASE_URL)) throw new Error("Заявка извън lstarbg.com е забранена");
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    headers.set("Accept-Language", "bg-BG,bg;q=0.9");
    if (jar.size) headers.set("Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));

    for (let attempt = 0; ; attempt++) {
      await pace();
      counters.requests++;
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, method, headers, redirect: "manual" });
      } catch (error) {
        if (method !== "GET" || attempt >= RETRY_DELAYS_MS.length) throw error;
        counters.retries++;
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      storeCookies(res.headers);

      if (res.status === 401 || res.status === 403) {
        throw new Error(`lstarbg.com отказа достъп (HTTP ${res.status}) - спирам`);
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || redirects >= 5) return res;
        const next = new URL(location, url).toString();
        return send(next, { headers: init.headers }, redirects + 1);
      }
      if (method === "GET" && RETRYABLE.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
        counters.retries++;
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return res;
    }
  }

  async function fetchText(url: string): Promise<string> {
    const res = await send(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} за ${new URL(url).search}`);
    return res.text();
  }

  async function login(): Promise<void> {
    await fetchText(`${BASE_URL}/index.php?route=account/login`); // взима сесийната бисквитка
    const body = new URLSearchParams({ email, password });
    await send(`${BASE_URL}/index.php?route=account/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const account = await fetchText(`${BASE_URL}/index.php?route=account/account`);
    if (!/route=account\/logout/.test(account)) {
      throw new Error("Входът в lstarbg.com не успя (провери LSTAR_EMAIL / LSTAR_PASSWORD)");
    }
    log(`Вход в lstarbg.com: успешен (бисквитки: ${jar.size})`);
  }

  return { login, fetchText, getCounters: () => ({ ...counters }) };
}
