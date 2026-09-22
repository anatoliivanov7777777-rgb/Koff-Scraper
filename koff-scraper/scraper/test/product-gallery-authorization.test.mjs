import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createKoffClient } from "../koff-client.mjs";
import { fetchGalleriesBounded } from "../product-gallery.mjs";

// All OFFLINE: fetchImpl is injected; no Koff host is ever contacted.

function detailResponse(urls, { status = 200 } = {}) {
  return new Response(JSON.stringify({ images: urls.map((url) => ({ url })) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Mocks the session handshake locally (CSRF page, login POST, token refresh)
 * so each test can start from a real signed-in client, exactly as scrape.mjs
 * does before it ever reaches the gallery pass. Nothing leaves the process.
 */
function authFixture() {
  return (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/en") {
      return new Response(`<meta name="csrf-token" content="csrf-fixture">`, {
        status: 200,
        headers: { "Content-Type": "text/html", "Set-Cookie": "_csrf=csrf-fixture; Path=/" },
      });
    }
    if (path === "/login/enter") return json({ success: true });
    if (path === "/login/refresh") return json({ accessToken: "fixture-token" });
    return null; // not part of the handshake
  };
}

function makeClient({ handler, clock = createClock(), ...overrides }) {
  const calls = [];
  const handshake = authFixture();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const authResponse = handshake(url, options);
    if (authResponse) return authResponse;
    return handler(url, options);
  };
  const client = createKoffClient({
    email: "fixture@example.invalid",
    password: "fixture-password",
    fetchImpl,
    logger: { info() {}, error() {} },
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
  return { client, calls, clock };
}

// --------------------------------------------------------------------------
// 17. Gallery traversal aborts on the authorization latch
// --------------------------------------------------------------------------

test("17. gallery traversal aborts cleanly when Koff answers 401", async () => {
  const ids = Array.from({ length: 200 }, (_, i) => 400000 + i);
  const { client, calls } = makeClient({
    handler: () => new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  });
  await client.login();

  const { galleries, counters, abortedForAuthorization } = await fetchGalleriesBounded(
    client,
    ids,
    { concurrency: 5 }
  );

  assert.equal(abortedForAuthorization, true);
  assert.equal(client.hasAuthorizationFailure(), true);

  // The whole point: the pool drains after the first refusal instead of
  // marching through the remaining ids. Bucket the product-detail calls.
  const detailCalls = calls.filter((c) => c.url.includes("/api/product/"));
  assert.ok(
    detailCalls.length <= 5,
    `expected the pool to stop after the refusal, saw ${detailCalls.length} detail requests`
  );
  assert.ok(detailCalls.length < ids.length, "must not fetch every product");

  // The rest simply have no gallery this run - never an authoritative empty one.
  for (const id of ids.slice(detailCalls.length)) {
    assert.equal(galleries.has(id), false);
  }
  assert.equal(counters.succeeded, 0);
});

test("17b. a 403 during traversal also aborts, and partial results are still usable", async () => {
  const ids = [500001, 500002, 500003, 500004];
  let seen = 0;
  const { client } = makeClient({
    handler: () => {
      seen++;
      // First two succeed, then Koff refuses.
      if (seen <= 2) return detailResponse([`https://cdn.koff.ro/img/${seen}.webp`]);
      return new Response(JSON.stringify({ message: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await client.login();

  const { galleries, abortedForAuthorization } = await fetchGalleriesBounded(client, ids, {
    concurrency: 1,
  });

  assert.equal(abortedForAuthorization, true);
  const ok = [...galleries.values()].filter((g) => g.ok);
  assert.ok(ok.length >= 1, "galleries fetched before the refusal are kept");
  assert.ok(ok.every((g) => Array.isArray(g.images)));
});

// --------------------------------------------------------------------------
// 19. Concurrent gallery workers still obey the global pacing
// --------------------------------------------------------------------------

test("19. concurrent gallery workers share the client-wide pacing", async () => {
  const clock = createClock();
  const ids = [600001, 600002, 600003, 600004, 600005];
  const { client } = makeClient({
    clock,
    handler: () => detailResponse(["https://cdn.koff.ro/img/a.webp"]),
  });
  await client.login();

  await fetchGalleriesBounded(client, ids, { concurrency: 5 });

  // Every start - the one token refresh plus all five detail requests - is
  // spaced by the shared interval: N starts produce exactly N-1 gaps, each
  // exactly one interval, never zero even though the workers ran concurrently.
  const counters = client.getRequestCounters();
  assert.ok(counters.requests >= ids.length, "all products were attempted");
  assert.deepEqual(clock.sleeps, Array(counters.requests - 1).fill(500));
});

test("19b. pacing is one global gate, not one per caller", async () => {
  const clock = createClock();
  const { client } = makeClient({
    clock,
    handler: () => detailResponse([]),
  });
  await client.login();

  // Two independent consumers racing, as scrape.mjs's category crawl and the
  // gallery pass would if they overlapped.
  await Promise.all([
    fetchGalleriesBounded(client, [700001, 700002], { concurrency: 2 }),
    client.request("/api/category"),
  ]);

  // One interval between every consecutive start, whatever the interleaving
  // was - the gallery pass and the direct crawl call share one gate.
  const total = client.getRequestCounters().requests;
  assert.deepEqual(clock.sleeps, Array(total - 1).fill(500));
});

// --------------------------------------------------------------------------
// 18. Gallery fetching stays opt-in
// --------------------------------------------------------------------------

test("18. gallery fetching remains opt-in in scrape.mjs", () => {
  const source = readFileSync(new URL("../scrape.mjs", import.meta.url), "utf8");
  // Off unless the caller explicitly opts in.
  assert.match(source, /const ENABLE_GALLERY_FETCH = process\.env\.ENABLE_GALLERY_FETCH === "true";/);
  // And the only gallery pass is guarded by it.
  const guard = source.indexOf("if (ENABLE_GALLERY_FETCH) {");
  assert.notEqual(guard, -1);
  // The gallery pass - now planner-driven - still sits inside that guard, and
  // still reaches Koff only through the hardened bounded pool.
  const guardBody = source.slice(guard);
  assert.ok(guardBody.includes("runIncrementalGalleryPass("));
  assert.ok(guardBody.includes("fetchGalleriesBounded("));
  assert.ok(guardBody.includes("GALLERY_FETCH_CONCURRENCY"));
  // The redundant per-category sleep is gone, so pacing is not stacked.
  assert.doesNotMatch(source, /setTimeout\(r,\s*300\)/);
});

test("18b. the weekly/manual workflows were not touched by this change", () => {
  // Business schedule and workflow behaviour are out of scope for this fix;
  // this asserts the scraper module itself never sets a schedule or enables
  // the gallery fetch on the caller's behalf.
  const source = readFileSync(new URL("../scrape.mjs", import.meta.url), "utf8");
  // Never FORCED on in code - only ever read from the environment. (A message
  // string may legitimately mention the flag, so match an assignment.)
  assert.doesNotMatch(source, /ENABLE_GALLERY_FETCH\s*=\s*true\s*;/);
  assert.match(source, /const ENABLE_GALLERY_FETCH = process\.env\.ENABLE_GALLERY_FETCH === "true";/);
  assert.doesNotMatch(source, /cron|schedule/i);
});
