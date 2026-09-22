import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKoffClient,
  parseRetryAfterMs,
  resolveMinRequestIntervalMs,
} from "../koff-client.mjs";

// Every test here is OFFLINE: fetchImpl is injected and nothing resolves a real
// host. shop.koff.ro / cdn.koff.ro are never contacted.

function response(body, { status = 200, headers = {}, contentType = "application/json" } = {}) {
  return new Response(contentType === "application/json" ? JSON.stringify(body ?? null) : body, {
    status,
    headers: { "Content-Type": contentType, ...headers },
  });
}

/** The CSRF page the client scrapes its token out of. */
function csrfPage(token = "csrf-fixture", headers = {}) {
  return response(`<meta name="csrf-token" content="${token}">`, {
    contentType: "text/html",
    headers,
  });
}

/**
 * Virtual clock. `sleep` never waits in real time - it advances the clock and
 * records the requested duration, so pacing/backoff is asserted exactly and
 * the suite runs instantly and deterministically.
 */
function createClock(start = 1_000_000) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    sleeps,
    advance: (ms) => {
      current += ms;
    },
  };
}

function makeClient({ queue, clock = createClock(), ...overrides } = {}) {
  const calls = [];
  const fetchImpl = overrides.fetchImpl ?? (async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) throw new Error("unexpected request: queue exhausted");
    return typeof next === "function" ? next(url, options) : next;
  });
  const logs = { info: [], error: [] };
  const logger = {
    info: (...a) => logs.info.push(a.join(" ")),
    error: (...a) => logs.error.push(a.join(" ")),
  };
  const client = createKoffClient({
    email: "fixture@example.invalid",
    password: "fixture-password",
    fetchImpl,
    logger,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
  return { client, calls, clock, logs };
}

// --------------------------------------------------------------------------
// 1-3. Pacing
// --------------------------------------------------------------------------

test("1. default request interval is 500 ms", () => {
  assert.equal(resolveMinRequestIntervalMs(undefined), 500);
  assert.equal(resolveMinRequestIntervalMs(""), 500);
  assert.equal(resolveMinRequestIntervalMs("not-a-number"), 500);
  assert.equal(resolveMinRequestIntervalMs(-1), 500);
  const { client } = makeClient({ queue: [] });
  assert.equal(client.getRequestIntervalMs(), 500);
});

test("2. a configured interval is respected", async () => {
  const clock = createClock();
  const { client } = makeClient({
    clock,
    minRequestIntervalMs: 1200,
    queue: [response({ ok: 1 }), response({ ok: 2 })],
  });
  assert.equal(client.getRequestIntervalMs(), 1200);

  await client.request("/api/category");
  await client.request("/api/category");

  // First request starts immediately; the second is spaced by exactly 1200ms.
  assert.deepEqual(clock.sleeps, [1200]);
});

test("3. concurrent callers share the same client-wide pacing", async () => {
  const clock = createClock();
  const { client } = makeClient({
    clock,
    queue: [response({}), response({}), response({}), response({})],
  });

  // Four starts requested at once, as the gallery pool does.
  await Promise.all([
    client.request("/api/category"),
    client.request("/api/category"),
    client.request("/api/category"),
    client.request("/api/category"),
  ]);

  // Starts are serialised: three gaps of one interval, not zero.
  assert.deepEqual(clock.sleeps, [500, 500, 500]);
  assert.equal(client.getRequestCounters().requests, 4);
});

// --------------------------------------------------------------------------
// 4-10. Safe-GET retries
// --------------------------------------------------------------------------

test("4. a GET is retried on 429", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    queue: [response({}, { status: 429 }), response({ ok: true })],
  });
  const res = await client.request("/api/category");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  // Retry-After absent -> deterministic first fallback step.
  assert.deepEqual(clock.sleeps, [1000]);
});

test("5. Retry-After is respected", async () => {
  const clock = createClock();
  const { client } = makeClient({
    clock,
    queue: [
      response({}, { status: 429, headers: { "Retry-After": "7" } }),
      response({ ok: true }),
    ],
  });
  await client.request("/api/category");
  assert.deepEqual(clock.sleeps, [7000]);
});

test("5b. an HTTP-date Retry-After is understood too", async () => {
  const clock = createClock();
  const when = new Date(clock.now() + 3000).toUTCString();
  const { client } = makeClient({
    clock,
    queue: [
      response({}, { status: 503, headers: { "Retry-After": when } }),
      response({ ok: true }),
    ],
  });
  await client.request("/api/category");
  assert.deepEqual(clock.sleeps, [3000]);
});

test("5c. an unusable Retry-After falls back deterministically", () => {
  assert.equal(parseRetryAfterMs("garbage", 0), null);
  assert.equal(parseRetryAfterMs(undefined, 0), null);
  assert.equal(parseRetryAfterMs("", 0), null);
  // A past HTTP-date means "retry now", never a negative wait.
  assert.equal(parseRetryAfterMs(new Date(500).toUTCString(), 1000), 0);
});

test("6. fallback retry waits are exactly 1s, 2s, 4s", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    queue: [
      response({}, { status: 503 }),
      response({}, { status: 503 }),
      response({}, { status: 503 }),
      response({ ok: true }),
    ],
  });
  const res = await client.request("/api/category");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 4);
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000]);
});

test("7-9. GET is retried on 502, 503 and 504", async () => {
  for (const status of [502, 503, 504]) {
    const { client, calls } = makeClient({
      queue: [response({}, { status }), response({ ok: true })],
    });
    const res = await client.request("/api/category");
    assert.equal(res.status, 200, `status ${status} should be retried`);
    assert.equal(calls.length, 2, `status ${status} should make 2 attempts`);
    assert.equal(client.getRequestCounters().transient5xx, 1);
  }
});

test("10. at most 3 retries - 4 attempts - then the response is returned", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    queue: [
      response({}, { status: 429 }),
      response({}, { status: 429 }),
      response({}, { status: 429 }),
      response({}, { status: 429 }),
    ],
  });
  const res = await client.request("/api/category");
  assert.equal(res.status, 429, "the final response is handed back, not thrown");
  assert.equal(calls.length, 4, "1 initial + 3 retries");
  assert.deepEqual(clock.sleeps, [1000, 2000, 4000]);
  const counters = client.getRequestCounters();
  assert.equal(counters.requests, 4);
  assert.equal(counters.retries, 3);
  assert.equal(counters.http429, 4);
});

test("10b. a non-retryable status is returned untouched on a GET", async () => {
  const { client, calls } = makeClient({ queue: [response({}, { status: 404 })] });
  const res = await client.request("/api/category");
  assert.equal(res.status, 404);
  assert.equal(calls.length, 1);
});

// --------------------------------------------------------------------------
// 11-15. Never retried
// --------------------------------------------------------------------------

test("11-12. 401 and 403 are never retried", async () => {
  for (const status of [401, 403]) {
    const clock = createClock();
    const { client, calls } = makeClient({
      clock,
      queue: [response({}, { status })],
    });
    const res = await client.request("/api/category");
    assert.equal(res.status, status);
    assert.equal(calls.length, 1, `${status} must not be retried`);
    assert.deepEqual(clock.sleeps, [], `${status} must not back off`);
    assert.equal(client.getRequestCounters().retries, 0);
  }
});

test("13. a POST is never retried, even on a retryable status", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    queue: [response({}, { status: 503 })],
  });
  const res = await client.request("/api/anything", { method: "POST" });
  assert.equal(res.status, 503);
  assert.equal(calls.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("14. the login POST is never retried", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    queue: [
      csrfPage(),
      response({}, { status: 503 }),
    ],
  });
  await assert.rejects(() => client.login(), /HTTP 503/);
  // CSRF GET + one login POST, and the POST was not repeated.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "POST");
  const postCalls = calls.filter((c) => c.options.method === "POST");
  assert.equal(postCalls.length, 1, "login POST must be attempted exactly once");
});

test("15. a cart write is never retried (retry count stays 0)", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    liveCartWrites: true,
    queue: [
      csrfPage("csrf-fixture", { "Set-Cookie": "_csrf=csrf-cookie; Path=/" }),
      response({ success: true }),
      response({ accessToken: "fixture-token" }),
      response({}, { status: 503 }),
    ],
  });
  await client.login();
  await assert.rejects(() => client.setAbsoluteCartQuantity(371338, 2), /HTTP 503/);

  const writeCalls = calls.filter((c) => c.url.includes("/api/cart/add-products"));
  assert.equal(writeCalls.length, 1, "cart write must be attempted exactly once");
  assert.equal(client.getRequestCounters().retries, 0);
});

// --------------------------------------------------------------------------
// 16-17. Authorization latch
// --------------------------------------------------------------------------

test("16. a 401 latches the client: subsequent requests stop instead of hammering", async () => {
  const clock = createClock();
  const { client, calls } = makeClient({
    clock,
    queue: [response({}, { status: 401 }), response({ ok: true })],
  });

  const first = await client.request("/api/category");
  assert.equal(first.status, 401, "the caller still sees the real status");
  assert.equal(client.hasAuthorizationFailure(), true);
  assert.equal(client.getAuthorizationFailure().status, 401);

  await assert.rejects(() => client.request("/api/category"), (err) => {
    assert.equal(err.koffAuthorizationLatched, true);
    return true;
  });
  assert.equal(calls.length, 1, "no further outbound request was made");
  assert.equal(client.getRequestCounters().authFailures, 1);
});

test("16b. a 403 latches too, and the latch is reported once", async () => {
  const { client, calls, logs } = makeClient({
    queue: [response({}, { status: 403 })],
  });
  await client.request("/api/category");
  await assert.rejects(() => client.request("/api/category"));
  assert.equal(calls.length, 1);
  assert.equal(logs.error.length, 1, "the authorization failure is reported exactly once");
  assert.match(logs.error[0], /403/);
});

// --------------------------------------------------------------------------
// 20. Counters
// --------------------------------------------------------------------------

test("20. request counters are accurate enough to verify the policy", async () => {
  const { client } = makeClient({
    queue: [
      response({}, { status: 429 }),
      response({}, { status: 503 }),
      response({}, { status: 200 }),
      response({}, { status: 200 }),
    ],
  });
  await client.request("/api/a");
  await client.request("/api/b");

  const counters = client.getRequestCounters();
  assert.equal(counters.requests, 4, "every outbound attempt is counted");
  assert.equal(counters.retries, 2);
  assert.equal(counters.http429, 1);
  assert.equal(counters.transient5xx, 1);
  assert.equal(counters.authFailures, 0);
  // A snapshot, not a live handle.
  counters.requests = 999;
  assert.equal(client.getRequestCounters().requests, 4);
});

// --------------------------------------------------------------------------
// Secrets must not reach the log
// --------------------------------------------------------------------------

test("session cookie NAMES are not written to the log", async () => {
  const { client, logs } = makeClient({
    queue: [
      csrfPage("csrf-fixture", { "Set-Cookie": "_session_secret_name=abc; Path=/, _csrf=xyz; Path=/" }),
      response({ success: true }),
    ],
  });
  await client.login();
  const all = logs.info.join("\n");
  assert.doesNotMatch(all, /_session_secret_name/);
  assert.doesNotMatch(all, /_csrf/);
  assert.doesNotMatch(all, /abc|xyz/);
});
