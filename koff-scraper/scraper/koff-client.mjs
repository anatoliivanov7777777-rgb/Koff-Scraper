const DEFAULT_BASE_URL = "https://shop.koff.ro";
const DEFAULT_APP_VERSION = "0.9.78";
const TOKEN_MAX_AGE_MS = 8 * 60 * 1000;

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
} = {}) {
  requireCredential(email, "KOFF_EMAIL");
  requireCredential(password, "KOFF_PASSWORD");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (baseUrl !== DEFAULT_BASE_URL) throw new Error("Unexpected Koff base URL");

  const cookieJar = new Map();
  let accessToken = null;
  let tokenIssuedAt = 0;
  let lastCsrfToken = null;

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

  async function request(path, options = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error("Koff request path must be relative");
    }
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

    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, headers });
    captureCookies(response.headers);
    const responseToken = response.headers.get("access-token");
    if (responseToken) {
      accessToken = responseToken;
      tokenIssuedAt = now();
    }
    return response;
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
    logger.info?.(`Koff session cookies received: ${[...cookieJar.keys()].join(", ") || "none"}`);
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
  };
}
