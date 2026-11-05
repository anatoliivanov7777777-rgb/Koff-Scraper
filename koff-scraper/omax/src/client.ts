// Сесиен HTTP клиент за b2b.omax.bg. Същата политика като Koff/LStar:
// фиксирана пауза между заявките (700 ms), повторение само на GET при
// 429/502/503/504 или скъсана връзка, спиране при 401/403. Без ротация на
// IP/UA, без заобикаляне на защити. Паролата и бисквитките никога не се логват.
//
// Вход (2026-11-05): обикновена форма POST /bg/login/ с полета email, password,
// remember (+ скритите полета на формата, ако има). Логнатата страница има
// връзка "Изход" (/bg/login/logout/) - търсим я в HTML-а, но НИКОГА не я
// отваряме (иначе бихме излезли и от сесията на собственика в браузъра).

import { BASE_URL, looksLoggedOut } from "./parse.js";

const USER_AGENT = "CaseKing-catalog-sync/1.0 (+https://case-king.bg)";
const DEFAULT_INTERVAL_MS = 700;
const RETRYABLE = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 30_000;
export const LOGIN_PATH = "/bg/login/";

export interface OmaxClientOptions {
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function attr(tag: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"') : "";
}

/** Формата за вход: адрес и скритите полета (напр. CSRF), или null. */
export function parseLoginForm(html: string): { action: string; fields: Record<string, string> } | null {
  for (const form of html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) ?? []) {
    const open = /^<form[^>]*>/i.exec(form);
    if (!open || !/type\s*=\s*["']password["']/i.test(form)) continue;
    const fields: Record<string, string> = {};
    for (const input of form.match(/<input[^>]*>/gi) ?? []) {
      const name = attr(input, "name");
      if (name && (attr(input, "type") || "text").toLowerCase() === "hidden") fields[name] = attr(input, "value");
    }
    return { action: attr(open[0], "action") || LOGIN_PATH, fields };
  }
  return null;
}

/** Адрес, който изписва клиента - никога не се отваря. */
export function isForbiddenUrl(url: string): boolean {
  return /\/logout/i.test(new URL(url, BASE_URL).pathname);
}

export function createOmaxClient(options: OmaxClientOptions) {
  const { email, password, fetchImpl = globalThis.fetch, minIntervalMs = DEFAULT_INTERVAL_MS, sleep = defaultSleep, log = () => {} } = options;
  if (!email?.trim()) throw new Error("OMAX_EMAIL е задължителен");
  if (!password?.trim()) throw new Error("OMAX_PASSWORD е задължителен");

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
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /deleted/i.test(value) || /max-age=0|expires=thu, 01 jan 1970/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  }

  async function pace() {
    const wait = lastStart + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
  }

  async function send(url: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    if (!url.startsWith(BASE_URL)) throw new Error("Заявка извън b2b.omax.bg е забранена");
    if (isForbiddenUrl(url)) throw new Error("Адресът за изход никога не се отваря");
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
      if (res.status === 401 || res.status === 403) throw new Error(`b2b.omax.bg отказа достъп (HTTP ${res.status}) - спирам`);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || redirects >= 5) return res;
        try { await res.body?.cancel(); } catch { /* затворено */ }
        const next = new URL(location, url).toString();
        // След POST браузърът продължава с GET.
        return send(next, {}, redirects + 1);
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

  async function fetchText(pathOrUrl: string): Promise<string> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${BASE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
    const res = await send(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} за ${new URL(url).pathname}`);
    return res.text();
  }

  /** Страница, която ТРЯБВА да е логната: при изтекла сесия влиза отново веднъж. */
  async function fetchSignedIn(pathOrUrl: string): Promise<string> {
    let html = await fetchText(pathOrUrl);
    if (looksLoggedOut(html)) {
      log("Сесията в Omax е изтекла - влизам отново");
      await login();
      html = await fetchText(pathOrUrl);
      if (looksLoggedOut(html)) throw new Error("Omax: страницата е без вход и след повторен вход - спирам");
    }
    return html;
  }

  async function login(): Promise<void> {
    const page = await fetchText(LOGIN_PATH);
    if (!looksLoggedOut(page)) { log("Вход в b2b.omax.bg: вече е логнат"); return; }
    const form = parseLoginForm(page);
    if (!form) throw new Error("Формата за вход на b2b.omax.bg не е намерена - сайтът може да е сменен");
    const body = new URLSearchParams({ ...form.fields, email, password, remember: "1" });
    const action = new URL(form.action, `${BASE_URL}${LOGIN_PATH}`).toString();
    const res = await send(action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const after = res.ok ? await res.text() : "";
    const check = looksLoggedOut(after) ? await fetchText("/bg/") : after;
    if (looksLoggedOut(check)) throw new Error("Входът в b2b.omax.bg не успя (провери OMAX_EMAIL / OMAX_PASSWORD)");
    log(`Вход в b2b.omax.bg: успешен (бисквитки: ${jar.size})`);
  }

  return { login, fetchText, fetchSignedIn, getCounters: () => ({ ...counters }) };
}

export type OmaxClient = ReturnType<typeof createOmaxClient>;
