const DEFAULT_BASE_URL = "https://shop.koff.ro";
const DEFAULT_APP_VERSION = "0.9.78";
const TOKEN_MAX_AGE_MS = 8 * 60 * 1000;

// ---- Request policy -------------------------------------------------------
//
// One deterministic, polite request policy for the WHOLE client. Every
// outbound call - category crawl, gallery pool worker, CSRF page, cart read -
// goes through request() below, so there is exactly one place that decides
// how often Koff is asked anything and whether a failure is retried.
//
// This is deliberately NOT an anti-detection mechanism. There is no proxy, no
// IP/UA rotation, no fingerprint spoofing and no randomised timing anywhere in
// this file: the client asks less often, says who it is (X-App-Version), and
// stops when Koff says stop. Every wait below is a fixed, documented number.

/** Minimum spacing between outbound request START times, in milliseconds. */
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 500;

/** Statuses worth retrying on an idempotent request: busy, not broken. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Retries AFTER the initial attempt, so at most 4 total attempts. */
const MAX_RETRIES = 3;

/**
 * Deterministic fallback backoff when Retry-After is absent or unusable.
 * Fixed steps, no jitter: 1s, 2s, 4s.
 */
const FALLBACK_RETRY_DELAYS_MS = [1000, 2000, 4000];

/** Statuses that mean "this run is not authorised" - never retried. */
const AUTHORIZATION_FAILURE_STATUSES = new Set([401, 403]);

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reads the configured pacing interval. Falls back to the default for
 * anything that is not a non-negative integer, so a malformed env var can
 * never silently disable pacing (which would be the aggressive default).
 */
export function resolveMinRequestIntervalMs(raw) {
  const parsed = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_REQUEST_INTERVAL_MS;
}

/**
 * Parses a Retry-After header into milliseconds, or null when absent or
 * unusable. Supports both representations RFC 9110 defines: a non-negative
 * delta-seconds value, and an HTTP-date. An HTTP-date already in the past
 * yields 0 (retry immediately) rather than a negative wait.
 */
export function parseRetryAfterMs(value, nowMs) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) return null;
  return Math.max(0, parsedDate - nowMs);
}

function requireCredential(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function safeDecodeCookie(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function collectCartProductArrays(cart) {
  const arrays = [];
  const add = (value) => {
    if (Array.isArray(value)) arrays.push(value);
  };

  if (!cart || typeof cart !== "object") return arrays;
  add(cart.products);
  add(cart.mainCart?.products);
  add(cart.activeCart?.products);
  if (Array.isArray(cart.carts)) {
    for (const child of cart.carts) add(child?.products);
  }
  return arrays;
}

function positiveInteger(value) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInteger(value) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function normalizeCart(cart) {
  const lines = [];
  for (const products of collectCartProductArrays(cart)) {
    for (const item of products) {
      if (!item || typeof item !== "object") continue;
      const sourceProductId = positiveInteger(
        item.product_id ?? item.productId ?? item.product?.id
      );
      if (sourceProductId === null) continue;
      lines.push({
        sourceProductId,
        quantity: nonNegativeInteger(item.quantity ?? item.qty),
        cartLineId: positiveInteger(item.id ?? item.cart_product_id ?? item.cartLineId),
        sku: typeof (item.sku ?? item.product?.sku) === "string"
          ? (item.sku ?? item.product?.sku)
          : null,
      });
    }
  }
  return { lines };
}

export function findCartProduct(cart, sourceProductId) {
  const wanted = positiveInteger(sourceProductId);
  if (wanted === null) throw new Error("Invalid Koff catalog product ID");
  const normalized = cart?.lines && Array.isArray(cart.lines)
    ? cart
    : normalizeCart(cart);
  return normalized.lines.find((line) => line.sourceProductId === wanted) ?? {
    sourceProductId: wanted,
    quantity: 0,
    cartLineId: null,
    sku: null,
  };
}

export function createKoffClient({
  email,
  password,
  fetchImpl = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  appVersion = DEFAULT_APP_VERSION,
  liveCartWrites = process.env.KOFF_CART_LIVE === "true",
  logger = console,
  now = () => Date.now(),
  sleep = defaultSleep,
  minRequestIntervalMs = resolveMinRequestIntervalMs(process.env.KOFF_MIN_REQUEST_INTERVAL_MS),
} = {}) {
  requireCredential(email, "KOFF_EMAIL");
  requireCredential(password, "KOFF_PASSWORD");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (baseUrl !== DEFAULT_BASE_URL) throw new Error("Unexpected Koff base URL");

  const cookieJar = new Map();
  let accessToken = null;
  let tokenIssuedAt = 0;
  let lastCsrfToken = null;

  const requestIntervalMs = resolveMinRequestIntervalMs(minRequestIntervalMs);

  // Per-run telemetry. Counters only - never a credential or a body.
  const counters = { requests: 0, retries: 0, http429: 0, transient5xx: 0, authFailures: 0 };

  // Authorization latch. Set the first time Koff answers 401/403; from then on
  // every outbound call fails fast instead of continuing to hammer an endpoint
  // that has already told us to stop. Deliberately a latch, not a retry: an
  // authorization failure is a state to report, never to work around.
  let authFailure = null;

  // Pacing gate. Serialises the RESERVATION of a request start slot across the
  // whole client, then releases immediately so the actual in-flight request
  // still overlaps normally (the gallery pool keeps its concurrency; it just
  // cannot race ahead of the global interval). Only the start times are paced -
  // never randomised, never tied to how the previous response looked.
  let pacingChain = Promise.resolve();
  let nextStartAt = 0;

  async function acquireStartSlot() {
    const previous = pacingChain;
    let release;
    pacingChain = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      const waitMs = nextStartAt - now();
      if (waitMs > 0) await sleep(waitMs);
      nextStartAt = now() + requestIntervalMs;
    } finally {
      release();
    }
  }

  function latchAuthFailure(status) {
    if (!authFailure) {
      authFailure = { status, at: now() };
      counters.authFailures++;
      logger.error?.(
        `Koff returned HTTP ${status} - authorization failed. Stopping further Koff requests for this run.`
      );
    }
  }

  function assertNotLatched() {
    if (!authFailure) return;
    const error = new Error(
      `Koff authorization already failed with HTTP ${authFailure.status}; further requests are stopped`
    );
    error.koffAuthorizationLatched = true;
    error.koffAuthFailureStatus = authFailure.status;
    throw error;
  }

  function cookieHeaderString() {
    return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function captureCookies(headers) {
    const setCookies = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const equals = pair.indexOf("=");
      if (equals > 0) cookieJar.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }

  // One outbound attempt, excluding pacing/retry policy.
  async function attempt(path, options, method) {
    const headers = new Headers(options.headers || {});
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    headers.set("X-App-Version", appVersion);
    headers.set("X-Requested-With", "XMLHttpRequest");

    const cookieHeader = cookieHeaderString();
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    if (accessToken && !path.startsWith("/login") && !path.startsWith("/register")) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }

    await acquireStartSlot();
    counters.requests++;
    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, method, headers });
    captureCookies(response.headers);
    const responseToken = response.headers.get("access-token");
    if (responseToken) {
      accessToken = responseToken;
      tokenIssuedAt = now();
    }
    return response;
  }

  /**
   * The single outbound boundary for the whole client.
   *
   * Pacing: every call - read, write, pool worker, CSRF page - reserves a
   * globally serialised start slot, so no caller can outrun the interval.
   *
   * Retries: ONLY idempotent GETs, and only for statuses that mean "busy, try
   * again" (429/502/503/504). A POST is never retried - that covers the login
   * POST, the token-refresh POST and the cart write, whose retry count stays
   * exactly 0. 401/403 are never retried and instead latch the client shut.
   *
   * Either way the final response is RETURNED, not thrown: callers keep
   * owning their own error semantics (this file's contract since the start).
   */
  async function request(path, options = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("Koff request path must be relative");
    }
    const method = (options.method || "GET").toUpperCase();
    const retryable = method === "GET";

    assertNotLatched();

    for (let attemptIndex = 0; ; attemptIndex++) {
      const response = await attempt(path, options, method);

      if (AUTHORIZATION_FAILURE_STATUSES.has(response.status)) {
        // Not retried, not worked around. The caller still sees this response
        // (so it can report the real status); the latch stops everything after.
        latchAuthFailure(response.status);
        return response;
      }

      if (!retryable || !RETRYABLE_STATUSES.has(response.status)) return response;

      if (response.status === 429) counters.http429++;
      else counters.transient5xx++;

      if (attemptIndex >= MAX_RETRIES) return response;

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now());
      const waitMs = retryAfterMs === null ? FALLBACK_RETRY_DELAYS_MS[attemptIndex] : retryAfterMs;
      counters.retries++;
      await sleep(waitMs);
    }
  }

  async function getCsrfToken() {
    const response = await request(`/en?_=${now()}`);
    if (!response.ok) throw new Error(`Koff CSRF page failed with HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(
      /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i
    );
    if (!match) throw new Error("Koff CSRF token was not available");
    return match[1];
  }

  async function login() {
    lastCsrfToken = await getCsrfToken();
    // Deliberately does NOT log cookie names: they are session material, the
    // count is all an operator needs, and the values must never reach a log.
    logger.info?.(`Koff session cookies received: ${cookieJar.size}`);
    const response = await request("/login/enter", {
      method: "POST",
      headers: { "X-CSRF-Token": lastCsrfToken },
      body: JSON.stringify({ username: email, password }),
    });
    if (!response.ok) throw new Error(`Koff login failed with HTTP ${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("Koff login returned an invalid response");
    }
    if (!body?.success) throw new Error("Koff login was rejected");
    logger.info?.("Koff login succeeded");
  }

  async function refreshAccessToken() {
    if (!lastCsrfToken) throw new Error("Koff session is not initialized");
    const response = await request("/login/refresh", {
      method: "POST",
      headers: { "X-CSRF-Token": lastCsrfToken },
    });
    if (!response.ok) throw new Error(`Koff token refresh failed with HTTP ${response.status}`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error("Koff token refresh returned an invalid response");
    }
    if (typeof body?.accessToken !== "string" || !body.accessToken) {
      throw new Error("Koff token refresh did not return an access token");
    }
    accessToken = body.accessToken;
    tokenIssuedAt = now();
    logger.info?.("Koff access token refreshed");
  }

  async function ensureFreshToken() {
    if (!accessToken || now() - tokenIssuedAt > TOKEN_MAX_AGE_MS) {
      await refreshAccessToken();
    }
  }

  async function getCart() {
    await ensureFreshToken();
    const response = await request("/api/cart?expand=products");
    if (!response.ok) throw new Error(`Koff cart read failed with HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error("Koff cart read returned an invalid response");
    }
  }

  async function setAbsoluteCartQuantity(productId, quantity) {
    if (!liveCartWrites) {
      const error = new Error("KOFF_CART_LIVE=true is required for cart writes");
      error.koffCartWriteAttempted = false;
      throw error;
    }
    const normalizedProductId = positiveInteger(productId);
    if (normalizedProductId === null || !Number.isInteger(quantity) || quantity < 1) {
      const error = new Error("Invalid absolute Koff cart quantity request");
      error.koffCartWriteAttempted = false;
      throw error;
    }

    await ensureFreshToken();
    const csrfCookie = cookieJar.get("_csrf");
    if (!csrfCookie) {
      const error = new Error("Koff CSRF cookie is unavailable");
      error.koffCartWriteAttempted = false;
      throw error;
    }

    let response;
    try {
      response = await request("/api/cart/add-products", {
        method: "POST",
        headers: { "X-CSRF-Token": safeDecodeCookie(csrfCookie) },
        body: JSON.stringify({
          products: [{ product_id: normalizedProductId, quantity }],
        }),
      });
    } catch {
      const error = new Error("Koff cart write transport failed");
      error.koffCartWriteAttempted = true;
      throw error;
    }

    if (!response.ok) {
      const error = new Error(`Koff cart write returned HTTP ${response.status}`);
      error.koffCartWriteAttempted = true;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      const error = new Error("Koff cart write returned an invalid response");
      error.koffCartWriteAttempted = true;
      throw error;
    }
  }

  return {
    login,
    ensureFreshToken,
    request,
    getCart,
    setAbsoluteCartQuantity,
    liveCartWritesEnabled: liveCartWrites === true,
    // Per-run telemetry, safe to log: counts only, never a credential or URL.
    getRequestCounters: () => ({ ...counters }),
    // True once Koff has answered 401/403 this run. Callers that own a
    // long-running loop (the gallery pool, the category crawl) poll this to
    // stop cleanly instead of discovering the latch one request at a time.
    hasAuthorizationFailure: () => authFailure !== null,
    getAuthorizationFailure: () => (authFailure ? { ...authFailure } : null),
    getRequestIntervalMs: () => requestIntervalMs,
  };
}
