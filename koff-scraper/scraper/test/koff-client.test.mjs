import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKoffClient,
  findCartProduct,
  normalizeCart,
} from "../koff-client.mjs";

function response(body, { status = 200, headers = {}, contentType = "application/json" } = {}) {
  return new Response(contentType === "application/json" ? JSON.stringify(body) : body, {
    status,
    headers: { "Content-Type": contentType, ...headers },
  });
}

test("cart normalization returns quantity zero when the catalog product is absent", () => {
  const line = findCartProduct({ products: [] }, 371338);
  assert.deepEqual(line, {
    sourceProductId: 371338,
    quantity: 0,
    cartLineId: null,
    sku: null,
  });
});

test("cart normalization keeps catalog product id separate from cart line id", () => {
  const normalized = normalizeCart({
    products: [{ id: 16516150, product_id: 371338, quantity: 2, sku: "KF2365572" }],
  });
  assert.deepEqual(normalized.lines, [{
    sourceProductId: 371338,
    quantity: 2,
    cartLineId: 16516150,
    sku: "KF2365572",
  }]);
  assert.equal(findCartProduct(normalized, 371338).cartLineId, 16516150);
  assert.equal(findCartProduct(normalized, 16516150).quantity, 0);
});

test("client uses the proven authenticated absolute-quantity cart contract with fake HTTP", async () => {
  const calls = [];
  const logs = [];
  const secrets = {
    email: "fixture@example.invalid",
    password: "fixture-password",
    metaCsrf: "meta-csrf-fixture",
    cookieCsrf: "cookie:csrf-fixture",
    token: "fixture-jwt-access-token",
  };
  const queue = [
    response(`<meta name="csrf-token" content="${secrets.metaCsrf}">`, {
      contentType: "text/html",
      headers: { "Set-Cookie": `_csrf=${encodeURIComponent(secrets.cookieCsrf)}; Path=/` },
    }),
    response({ success: true }),
    response({ accessToken: secrets.token, roles: ["customer"] }),
    response({ mainCart: {} }),
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return queue.shift();
  };
  const logger = { info: (...args) => logs.push(args.join(" ")) };
  const client = createKoffClient({
    email: secrets.email,
    password: secrets.password,
    fetchImpl,
    liveCartWrites: true,
    logger,
  });

  await client.login();
  await client.ensureFreshToken();
  await client.setAbsoluteCartQuantity(371338, 2);

  assert.equal(calls.length, 4);
  const write = calls[3];
  assert.equal(new URL(write.url).pathname, "/api/cart/add-products");
  assert.equal(write.options.method, "POST");
  assert.deepEqual(JSON.parse(write.options.body), {
    products: [{ product_id: 371338, quantity: 2 }],
  });
  assert.equal(write.options.headers.get("Authorization"), `Bearer ${secrets.token}`);
  assert.equal(write.options.headers.get("X-CSRF-Token"), secrets.cookieCsrf);
  assert.equal(write.options.headers.get("X-Requested-With"), "XMLHttpRequest");
  assert.equal(write.options.headers.get("X-App-Version"), "0.9.78");
  assert.match(write.options.headers.get("Cookie"), /_csrf=/);

  const logged = logs.join(" ");
  for (const value of Object.values(secrets)) assert.equal(logged.includes(value), false);
});

test("live guard prevents the cart POST before any fake HTTP request", async () => {
  let fetchCalls = 0;
  const client = createKoffClient({
    email: "fixture@example.invalid",
    password: "fixture-password",
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("must not be called");
    },
    liveCartWrites: false,
    logger: {},
  });

  await assert.rejects(
    client.setAbsoluteCartQuantity(371338, 2),
    (error) => error.koffCartWriteAttempted === false,
  );
  assert.equal(fetchCalls, 0);
});
