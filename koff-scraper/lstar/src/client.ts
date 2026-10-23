// Сесиен HTTP клиент за lstarbg.com. Същата политика като Koff клиента:
// фиксирана пауза между заявките, повторение само на GET при 429/502/503/504
// или скъсана връзка, спиране при 401/403. Без ротация на IP/UA, без
// заобикаляне на защити. Паролата и бисквитките никога не се логват.
//
// От 21.10.2026 сайтът е Next.js:
//   - входът е на /sign-in и е Next.js "server action" – обикновена multipart
//     форма с имейл, парола и скрити полета $ACTION_REF_1, $ACTION_1:0,
//     $ACTION_1:1, $ACTION_KEY. Полетата се взимат от самата страница при
//     всяко влизане (не се зашиват в кода – сменят се при нов билд).
//   - старият адрес /index.php?route=account/login вече дава 308 към /sign-in,
//     а /index.php?route=account/account – 404.
//   - логнат ли е клиентът, се проверява на /account: нелогнат получава
//     307 към /sign-in?next=..., логнатият – 200.
//   - старите адреси на категориите още пренасочват (308) към новите
//     /categories/..., затова resolveUrl() ги превежда.

const BASE_URL = "https://lstarbg.com";
const USER_AGENT = "CaseKing-catalog-sync/1.0 (+https://case-king.bg)";
const DEFAULT_INTERVAL_MS = 700;
const RETRYABLE = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 2000, 4000];
// A request that hangs is abandoned (and retried like a dropped connection).
// Without it one stuck response held the nightly job until its 120-minute
// limit (2026-10-22).
const REQUEST_TIMEOUT_MS = 30_000;

export interface LstarClientOptions {
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/** Скритите полета на формата за вход + адреса, на който се праща. */
export interface LoginForm {
  action: string;
  fields: Record<string, string>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const HTML_ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&#39;": "'",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

function unescapeHtml(value: string): string {
  return value.replace(/&(quot|amp|#39|#x27|lt|gt|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/** Стойността на атрибут от HTML таг (работи и при разбъркан ред на атрибутите). */
function attr(tag: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(tag);
  return m ? unescapeHtml(m[1] ?? m[2] ?? "") : "";
}

/**
 * Изважда формата за вход от /sign-in: адрес за POST и скритите полета.
 * Връща null, ако страницата не съдържа форма с парола (сайтът е сменен).
 */
export function parseLoginForm(html: string): LoginForm | null {
  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) ?? [];
  for (const form of forms) {
    const open = /^<form[^>]*>/i.exec(form);
    if (!open) continue;
    const inputs = form.match(/<input[^>]*>/gi) ?? [];
    const fields: Record<string, string> = {};
    let hasPassword = false;
    for (const input of inputs) {
      const name = attr(input, "name");
      if (!name) continue;
      const type = (attr(input, "type") || "text").toLowerCase();
      if (type === "password") hasPassword = true;
      if (type === "hidden") fields[name] = attr(input, "value");
    }
    if (!hasPassword) continue;
    const action = attr(open[0], "action");
    return { action, fields };
  }
  return null;
}

/** Съобщението за грешка, което Next.js връща в скритото поле $ACTION_1:1. */
export function loginErrorMessage(html: string): string | null {
  for (const m of html.matchAll(/<input[^>]*name="\$ACTION_[^"]*:1"[^>]*>/gi)) {
    try {
      const state = JSON.parse(attr(m[0], "value")) as unknown;
      const list = Array.isArray(state) ? state : [state];
      for (const item of list) {
        if (item && typeof item === "object" && "error" in item) {
          const error = (item as { error?: unknown }).error;
          if (typeof error === "string" && error.trim()) return error.trim();
        }
      }
    } catch {
      // полето не е JSON – продължаваме
    }
  }
  return null;
}

/** multipart/form-data тяло, сглобено на ръка (без File обекти). */
export function buildMultipart(
  fields: Record<string, string>,
  boundary: string,
): string {
  let body = "";
  for (const [name, value] of Object.entries(fields)) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${name.replace(/"/g, "%22")}"\r\n\r\n`;
    body += `${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return body;
}

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

  async function send(
    url: string,
    init: RequestInit = {},
    redirects = 0,
    followRedirects = true,
  ): Promise<Response> {
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
        res = await fetchImpl(url, { ...init, method, headers, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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
        if (!followRedirects || !location || redirects >= 5) return res;
        const next = new URL(location, url).toString();
        return send(next, { headers: init.headers }, redirects + 1, followRedirects);
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

  /**
   * Крайният адрес след пренасочване (308), без да теглим тялото.
   * Ползва се за старите адреси на категориите: index.php?...&path=496_567
   * -> /categories/originalni-aksesoari/originalni-keysove.
   */
  async function resolveUrl(url: string): Promise<string> {
    const res = await send(url, {}, 0, false);
    const location = res.headers.get("location");
    // Тялото не ни трябва – освобождаваме връзката.
    try {
      await res.body?.cancel();
    } catch {
      // вече е затворено
    }
    if (res.status >= 300 && res.status < 400 && location) {
      return new URL(location, url).toString();
    }
    return url;
  }

  /** Логнат ли е клиентът според /account (200 = да, 3xx към /sign-in = не). */
  async function isSignedIn(): Promise<boolean> {
    const res = await send(`${BASE_URL}/account`, {}, 0, false);
    try {
      await res.body?.cancel();
    } catch {
      // вече е затворено
    }
    return res.ok;
  }

  async function login(): Promise<void> {
    // 1. Страницата за вход – от нея идват скритите полета на server action-а.
    const page = await fetchText(`${BASE_URL}/sign-in`);
    const form = parseLoginForm(page);
    if (!form) {
      throw new Error("Формата за вход на lstarbg.com не е намерена - сайтът може да е сменен");
    }

    // 2. Самият вход: multipart POST към същия адрес, както го прави браузърът
    //    без JavaScript. Паролата отива само в тялото на заявката.
    const boundary = `----CaseKingLstarForm${Date.now().toString(16)}`;
    const body = buildMultipart({ ...form.fields, email, password }, boundary);
    const action = new URL(form.action || "/sign-in", BASE_URL).toString();
    const res = await send(action, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const result = await res.text();

    // 3. Проверка по същество: /account вече трябва да е достъпен.
    if (!(await isSignedIn())) {
      const message = loginErrorMessage(result);
      throw new Error(
        `Входът в lstarbg.com не успя${message ? `: ${message}` : ""} (провери LSTAR_EMAIL / LSTAR_PASSWORD)`,
      );
    }
    log(`Вход в lstarbg.com: успешен (бисквитки: ${jar.size})`);
  }

  return {
    login,
    fetchText,
    resolveUrl,
    isSignedIn,
    getCounters: () => ({ ...counters }),
  };
}
