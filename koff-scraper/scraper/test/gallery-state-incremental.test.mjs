import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GALLERY_STATUS,
  computeGalleryFingerprint,
  createGalleryMeta,
  normalizeCoverIdentity,
  planGalleryRefresh,
} from "../gallery-state.mjs";
import { createMemoryGalleryStateStore, runIncrementalGalleryPass } from "../gallery-state-store.mjs";

// All OFFLINE. Nothing here fetches: the fetch step is an injected spy, and the
// module under test performs no I/O of its own.
//
// NOTE ON CATALOG SCALE: the mass-request guard aborts above 2% of the
// catalog, and the real Koff catalog is ~28k products. A toy 3-product fixture
// would therefore trip the guard for a single changed product (33% > 2%) and
// test the guard instead of the incremental rule. These tests use a
// realistically sized catalog so the incremental cases are exercised for real.

const NOW = 1_700_000_000_000;
const CATALOG_SIZE = 1000;
const BASE_ID = 10_000;

const readyMeta = () => createGalleryMeta({ bootstrapCompleted: true, bootstrapRunId: "run-1", updatedAt: NOW });

const cover = (n) => `https://cdn.koff.ro/img/${n}.webp`;

function product(sourceProductId, imageUrl, extra = {}) {
  return { sourceProductId, imageUrl, ...extra };
}

/** A complete, cacheable state row. */
function readyRow(sourceProductId, imageUrl, images = [imageUrl]) {
  return {
    sourceProductId,
    sourceId: null,
    coverIdentity: normalizeCoverIdentity(imageUrl),
    galleryUrls: images,
    galleryFingerprint: computeGalleryFingerprint(images),
    lastSuccessfulFetchAt: NOW - 1000,
    lastAttemptAt: NOW - 1000,
    lastFailureAt: null,
    failureCount: 0,
    status: GALLERY_STATUS.READY,
  };
}

/** A full catalog of CATALOG_SIZE products whose covers never change. */
function bigCatalog() {
  return Array.from({ length: CATALOG_SIZE }, (_, i) => product(BASE_ID + i, cover(i)));
}

/**
 * State for a big catalog. `mutate(product, index)` may return a row to use, or
 * null to drop the row entirely (making that product "new").
 */
function bigState(catalog, mutate = () => undefined) {
  const rows = [];
  catalog.forEach((p, i) => {
    const custom = mutate(p, i);
    if (custom === null) return;
    rows.push(custom ?? readyRow(p.sourceProductId, p.imageUrl));
  });
  return rows;
}

/** A spy standing in for fetchGalleriesBounded: records ids, returns successes. */
function fetchSpy(imagesFor = () => ["https://cdn.koff.ro/img/new.webp"]) {
  const calls = [];
  const fn = async (ids) => {
    calls.push([...ids]);
    const galleries = new Map();
    for (const id of ids) galleries.set(id, { ok: true, images: imagesFor(id) });
    return { galleries, counters: { attempted: ids.length, succeeded: ids.length, failed: 0, totalImagesFound: 0 } };
  };
  fn.calls = calls;
  fn.totalIds = () => calls.reduce((n, batch) => n + batch.length, 0);
  return fn;
}

// --------------------------------------------------------------------------
// 1-6, 9. Candidate selection
// --------------------------------------------------------------------------

test("1. an unchanged catalog causes zero detail fetches", async () => {
  const catalog = bigCatalog();
  const stateRows = bigState(catalog);

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.equal(plan.abort, false);
  assert.deepEqual(plan.candidates, [], "nothing to do");
  assert.equal(plan.candidateCount, 0);

  const fetchGalleries = fetchSpy();
  const store = createMemoryGalleryStateStore({ meta: readyMeta(), rows: stateRows });
  await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });

  assert.equal(fetchGalleries.calls.length, 0, "the fetch step was never reached");
  assert.equal(fetchGalleries.totalIds(), 0, "no detail request was made");
});

test("2. a new sourceProductId is a candidate", () => {
  const catalog = bigCatalog();
  const newcomer = product(777_001, cover(9999));
  catalog.push(newcomer);
  const stateRows = bigState(catalog.filter((p) => p !== newcomer));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.deepEqual(plan.candidates, [{ sourceProductId: 777_001, reason: "no-state-row" }]);
  assert.equal(plan.abort, false);
});

test("3. a changed cover is a candidate", () => {
  const catalog = bigCatalog();
  const changed = catalog[7];
  changed.imageUrl = cover(50_000);
  const stateRows = bigState(catalog, (p) => (p === changed ? readyRow(p.sourceProductId, cover(7)) : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.deepEqual(plan.candidates, [{ sourceProductId: changed.sourceProductId, reason: "cover-changed" }]);
});

test("3b. a cache-busting query string is NOT a change", () => {
  // Koff appends ?_= on some paths; treating that as a cover change would make
  // every run fetch the whole catalog again.
  assert.equal(
    normalizeCoverIdentity("https://cdn.koff.ro/img/a.webp?_=1700000000"),
    normalizeCoverIdentity("https://cdn.koff.ro/img/a.webp")
  );

  const catalog = bigCatalog();
  catalog[3].imageUrl = `${cover(3)}?_=1700000123`;
  const plan = planGalleryRefresh({ catalog, stateRows: bigState(catalog), meta: readyMeta() });
  assert.deepEqual(plan.candidates, []);
});

test("4. a previously failed product is eligible for retry", () => {
  const catalog = bigCatalog();
  const failed = catalog[11];
  const stateRows = bigState(catalog, (p) => (p === failed
    ? { ...readyRow(p.sourceProductId, p.imageUrl), status: GALLERY_STATUS.FAILED, failureCount: 2 }
    : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.deepEqual(plan.candidates, [{ sourceProductId: failed.sourceProductId, reason: "failed-retry" }]);
});

test("4b. a failed row that still knows its gallery is retried, not re-discovered", () => {
  const cached = [cover(0), cover(1)];
  const catalog = bigCatalog();
  const failed = catalog[12];
  const stateRows = bigState(catalog, (p) => (p === failed
    ? { ...readyRow(p.sourceProductId, p.imageUrl, cached), status: GALLERY_STATUS.FAILED, failureCount: 1 }
    : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.deepEqual(plan.candidates, [{ sourceProductId: failed.sourceProductId, reason: "failed-retry" }]);
});

test("5. an individually missing/incomplete row is a candidate", () => {
  const cases = [
    { label: "no successful fetch recorded", patch: { lastSuccessfulFetchAt: null } },
    { label: "no fingerprint", patch: { galleryFingerprint: null } },
    { label: "status missing", patch: { status: GALLERY_STATUS.MISSING } },
  ];

  for (const { label, patch } of cases) {
    const catalog = bigCatalog();
    const target = catalog[21];
    const stateRows = bigState(catalog, (p) => (p === target
      ? { ...readyRow(p.sourceProductId, p.imageUrl), ...patch }
      : undefined));

    const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
    assert.equal(plan.candidates.length, 1, `${label} should be a candidate`);
    assert.equal(plan.candidates[0].reason, "state-incomplete", label);
    assert.equal(plan.candidates[0].sourceProductId, target.sourceProductId, label);
  }
});

test("6. an unchanged row reuses its cached gallery", async () => {
  const cached = [cover(0), cover(1)];
  const catalog = bigCatalog();
  const store = createMemoryGalleryStateStore({
    meta: readyMeta(),
    rows: bigState(catalog, (p) => (p.sourceProductId === BASE_ID ? readyRow(p.sourceProductId, p.imageUrl, cached) : undefined)),
  });
  const fetchGalleries = fetchSpy();

  const outcome = await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });

  assert.equal(fetchGalleries.totalIds(), 0);
  assert.equal(outcome.saved, false, "nothing changed, so nothing was written");
  // The cached gallery is still there for the sync step to use.
  const row = store.peek().rows.find((r) => r.sourceProductId === BASE_ID);
  assert.deepEqual(row.galleryUrls, cached);
});

// --------------------------------------------------------------------------
// 7-8. Applying results
// --------------------------------------------------------------------------

test("7. a successful candidate updates gallery state", async () => {
  const catalog = bigCatalog();
  const fresh = product(777_002, cover(9998));
  catalog.push(fresh);
  const store = createMemoryGalleryStateStore({ meta: readyMeta(), rows: bigState(catalog.filter((p) => p !== fresh)) });
  const fetchGalleries = fetchSpy(() => [cover(0), cover(1)]);

  await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });

  assert.deepEqual(fetchGalleries.calls, [[777_002]], "only the new product was fetched");
  const row = store.peek().rows.find((r) => r.sourceProductId === 777_002);
  assert.ok(row, "state row written");
  assert.equal(row.status, GALLERY_STATUS.READY);
  assert.deepEqual(row.galleryUrls, [cover(0), cover(1)]);
  assert.equal(row.galleryFingerprint, computeGalleryFingerprint([cover(0), cover(1)]));
  assert.equal(row.lastSuccessfulFetchAt, NOW);
  assert.equal(row.failureCount, 0);
  assert.equal(row.coverIdentity, normalizeCoverIdentity(cover(9998)));
});

test("8. a failed refresh does NOT erase the last known good gallery", async () => {
  const cached = [cover(0), cover(1)];
  const catalog = bigCatalog();
  const changed = catalog[31];
  changed.imageUrl = cover(60_000); // cover changed -> candidate
  const store = createMemoryGalleryStateStore({
    meta: readyMeta(),
    rows: bigState(catalog, (p) => (p === changed ? readyRow(p.sourceProductId, cover(31), cached) : undefined)),
  });
  const fetchGalleries = async (ids) => ({
    galleries: new Map(ids.map((id) => [id, { ok: false, images: [] }])),
    counters: { attempted: ids.length, succeeded: 0, failed: ids.length, totalImagesFound: 0 },
  });

  await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });

  const row = store.peek().rows.find((r) => r.sourceProductId === changed.sourceProductId);
  assert.equal(row.status, GALLERY_STATUS.FAILED);
  assert.equal(row.lastFailureAt, NOW);
  assert.equal(row.failureCount, 1);
  // The whole point: the previously known gallery survives the failure.
  assert.deepEqual(row.galleryUrls, cached);
  assert.equal(row.galleryFingerprint, computeGalleryFingerprint(cached));
  assert.equal(row.lastSuccessfulFetchAt, NOW - 1000);

  // ...and the next run retries it rather than silently treating it as cached.
  const plan = planGalleryRefresh({ catalog, stateRows: store.peek().rows, meta: readyMeta() });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].reason, "failed-retry");
});

// --------------------------------------------------------------------------
// 9-10. The key
// --------------------------------------------------------------------------

test("9. sourceProductId is the state key", () => {
  // Two different raw products that happen to share a cover stay separate.
  const shared = cover(0);
  const catalog = bigCatalog();
  const twin = product(888_001, shared);
  catalog.push(twin);
  const stateRows = bigState(catalog.filter((p) => p !== twin));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.deepEqual(plan.candidates, [{ sourceProductId: 888_001, reason: "no-state-row" }]);
});

test("9b. state is never keyed by name, slug or variant", () => {
  // Same raw id, three different display names: one state row, one candidate.
  const rawId = 371_338;
  const catalog = [
    { sourceProductId: rawId, name: "Variant A - iPhone 16", slug: "variant-a", imageUrl: cover(1) },
    { sourceProductId: rawId, name: "Variant B - iPhone 16 Pro", slug: "variant-b", imageUrl: cover(1) },
    { sourceProductId: rawId, name: "Variant C", slug: "variant-c", imageUrl: cover(1) },
  ];
  const plan = planGalleryRefresh({ catalog, stateRows: [], meta: readyMeta(), maxCandidatePercent: 100 });
  assert.deepEqual(plan.candidates.map((c) => c.sourceProductId), [rawId]);
});

test("10. generated CaseKing variants do not create separate gallery fetches", async () => {
  const rawId = 371_338;
  const catalog = [
    { sourceProductId: rawId, imageUrl: cover(1) },
    { sourceProductId: rawId, imageUrl: cover(1) },
  ];
  const store = createMemoryGalleryStateStore({ meta: readyMeta(), rows: [] });
  const fetchGalleries = fetchSpy();

  await runIncrementalGalleryPass({
    store,
    catalog,
    fetchGalleries,
    now: NOW,
    plan: ({ catalog: c }) => planGalleryRefresh({ catalog: c, stateRows: [], meta: readyMeta(), maxCandidatePercent: 100 }),
  });

  assert.equal(fetchGalleries.totalIds(), 1, "one detail request for two storefront rows");
  assert.equal(store.peek().rows.length, 1, "one state row for the raw product");
});

// --------------------------------------------------------------------------
// 11-12. Global state guard
// --------------------------------------------------------------------------

test("11. missing global state aborts with zero detail fetches", async () => {
  const catalog = bigCatalog();
  const plan = planGalleryRefresh({ catalog, stateRows: [], meta: null });
  assert.equal(plan.abort, true);
  assert.deepEqual(plan.candidates, []);
  assert.match(plan.reason, /missing/);

  const fetchGalleries = fetchSpy();
  const store = createMemoryGalleryStateStore({ meta: null, rows: [] });
  const outcome = await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });

  assert.equal(outcome.plan.abort, true);
  assert.equal(fetchGalleries.calls.length, 0, "the fetch step was never reached");
  assert.equal(outcome.fetched, 0);
  assert.equal(outcome.saved, false);
});

test("12. corrupt global state aborts with zero detail fetches", async () => {
  const catalog = bigCatalog();
  const corruptCases = [
    { label: "wrong schema version", meta: { ...readyMeta(), schemaVersion: 99 } },
    { label: "bootstrap flag false", meta: { ...readyMeta(), bootstrapCompleted: false } },
    { label: "not an object", meta: "garbage" },
    { label: "null", meta: null },
  ];

  for (const { label, meta } of corruptCases) {
    const plan = planGalleryRefresh({ catalog, stateRows: [], meta });
    assert.equal(plan.abort, true, `${label} must abort`);
    assert.deepEqual(plan.candidates, [], label);

    const fetchGalleries = fetchSpy();
    const store = createMemoryGalleryStateStore({ meta, rows: [] });
    await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });
    assert.equal(fetchGalleries.calls.length, 0, `${label} must make no requests`);
  }
});

// --------------------------------------------------------------------------
// 13-14. Mass-request guard
// --------------------------------------------------------------------------

test("13. more than 500 candidates aborts with zero detail fetches", async () => {
  // 4000 products, 600 with changed covers: 15% is well over 2%, and 600 is
  // over the 500 ceiling, so the COUNT limit is what the reason names.
  const catalog = Array.from({ length: 4000 }, (_, i) => product(BASE_ID + i, cover(i)));
  const stateRows = bigState(catalog, (p, i) => (i < 600 ? readyRow(p.sourceProductId, cover(90_000 + i)) : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.equal(plan.abort, true);
  assert.deepEqual(plan.candidates, []);
  assert.match(plan.reason, /exceeds the 500 limit/);

  const fetchGalleries = fetchSpy();
  const store = createMemoryGalleryStateStore({ meta: readyMeta(), rows: stateRows });
  await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });
  assert.equal(fetchGalleries.calls.length, 0);
});

test("14. more than 2% of the catalog aborts with zero detail fetches", async () => {
  // 1000 products, 40 changed = 4% - under the 500 ceiling, over the 2%.
  const catalog = bigCatalog();
  const stateRows = bigState(catalog, (p, i) => (i < 40 ? readyRow(p.sourceProductId, cover(90_000 + i)) : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.equal(plan.abort, true);
  assert.deepEqual(plan.candidates, []);
  assert.match(plan.reason, /% of the catalog/);

  const fetchGalleries = fetchSpy();
  const store = createMemoryGalleryStateStore({ meta: readyMeta(), rows: stateRows });
  await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });
  assert.equal(fetchGalleries.calls.length, 0);
});

test("14b. a run at exactly the guard boundary is allowed", () => {
  // 1000 products, 20 candidates = exactly 2% -> not "over" 2%.
  const catalog = bigCatalog();
  const stateRows = bigState(catalog, (p, i) => (i < 20 ? readyRow(p.sourceProductId, cover(90_000 + i)) : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.equal(plan.abort, false);
  assert.equal(plan.candidateCount, 20);
  assert.equal(plan.candidatePercent, 2);
});

test("14c. the abort reports the candidate count, the percentage and the reason", async () => {
  const catalog = bigCatalog();
  const stateRows = bigState(catalog, (p, i) => (i < 300 ? readyRow(p.sourceProductId, cover(90_000 + i)) : undefined));

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.equal(plan.abort, true);
  assert.equal(plan.candidateCount, 300, "the candidate count is reported on abort");
  assert.equal(plan.candidatePercent, 30, "the percentage is reported on abort");
  assert.ok(plan.reason, "a reason is reported on abort");
  assert.equal(plan.catalogSize, CATALOG_SIZE);

  // The per-reason breakdown is reported too, so an operator can see WHY.
  assert.equal(plan.counts["cover-changed"], 300);
});

// --------------------------------------------------------------------------
// 15-16. Full refresh escape hatch
// --------------------------------------------------------------------------

test("15. FULL_GALLERY_REFRESH defaults to false", async () => {
  const catalog = bigCatalog();
  const stateRows = bigState(catalog);

  const incremental = planGalleryRefresh({ catalog, stateRows, meta: readyMeta() });
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.candidates.length, 0);

  // The runtime wrapper's own default is likewise incremental.
  const store = createMemoryGalleryStateStore({ meta: readyMeta(), rows: stateRows });
  const fetchGalleries = fetchSpy();
  const outcome = await runIncrementalGalleryPass({ store, catalog, fetchGalleries, now: NOW });
  assert.equal(outcome.plan.mode, "incremental");
  assert.equal(fetchGalleries.totalIds(), 0);

  // And scrape.mjs only turns it on from an explicit env var.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../scrape.mjs", import.meta.url), "utf8");
  assert.match(source, /const FULL_GALLERY_REFRESH = process\.env\.FULL_GALLERY_REFRESH === "true";/);
});

test("16. an explicit full refresh bypasses the incremental guard", async () => {
  const catalog = bigCatalog();
  const stateRows = bigState(catalog);

  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta(), fullRefresh: true });
  assert.equal(plan.mode, "full");
  assert.equal(plan.abort, false, "the mass guard is intentionally bypassed");
  assert.equal(plan.candidates.length, CATALOG_SIZE, "every product is a candidate");

  // It also works without usable meta, because the operator asked for it.
  const withoutMeta = planGalleryRefresh({ catalog, stateRows: [], meta: null, fullRefresh: true });
  assert.equal(withoutMeta.abort, false);
  assert.equal(withoutMeta.candidates.length, CATALOG_SIZE);
});

test("16b. a full refresh marks every candidate with its own reason", () => {
  const catalog = bigCatalog();
  const stateRows = bigState(catalog);
  const plan = planGalleryRefresh({ catalog, stateRows, meta: readyMeta(), fullRefresh: true });
  assert.equal(plan.candidates[0].reason, "full-refresh");
  assert.deepEqual(plan.counts, { "full-refresh": CATALOG_SIZE });
});

// --------------------------------------------------------------------------
// 19-20. The hardened client is still the only way out
// --------------------------------------------------------------------------

test("19. the run still goes through the hardened client policy", async () => {
  // The pass delegates to the caller-supplied fetchGalleries, which is
  // product-gallery.mjs's fetchGalleriesBounded -> the hardened koff-client.
  // Assert the wiring itself, so a second HTTP client can never creep in.
  const { readFileSync } = await import("node:fs");
  for (const file of ["../gallery-state.mjs", "../gallery-state-store.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bfetch\(/, `${file} must not fetch directly`);
    assert.doesNotMatch(source, /node:https?/, `${file} must not open a socket`);
  }
  const scrapeSource = readFileSync(new URL("../scrape.mjs", import.meta.url), "utf8");
  assert.match(scrapeSource, /fetchGalleriesBounded/, "the runtime still calls the hardened gallery pool");
});

test("19b. the shared 500ms interval and safe-retry policy are unchanged", async () => {
  const mod = await import("../koff-client.mjs");
  assert.equal(mod.resolveMinRequestIntervalMs(undefined), 500);

  const clock = { t: 1_000_000 };
  const sleeps = [];
  const client = mod.createKoffClient({
    email: "a@b.invalid",
    password: "p",
    fetchImpl: async () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    logger: { info() {}, error() {} },
    now: () => clock.t,
    sleep: async (ms) => { sleeps.push(ms); clock.t += ms; },
  });
  await client.request("/api/a");
  await client.request("/api/b");
  assert.deepEqual(sleeps, [500], "one interval between the two starts");
});

test("20. the 401/403 latch still aborts gallery traversal", async () => {
  const { fetchGalleriesBounded } = await import("../product-gallery.mjs");
  const calls = [];
  const client = (await import("../koff-client.mjs")).createKoffClient({
    email: "a@b.invalid",
    password: "p",
    logger: { info() {}, error() {} },
    sleep: async () => {},
    fetchImpl: async (url) => {
      calls.push(url);
      const path = new URL(url).pathname;
      const json = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      if (path === "/en") {
        return new Response(`<meta name="csrf-token" content="c">`, {
          status: 200,
          headers: { "Content-Type": "text/html", "Set-Cookie": "_csrf=c; Path=/" },
        });
      }
      if (path === "/login/enter") return json({ success: true });
      if (path === "/login/refresh") return json({ accessToken: "t" });
      return json({ message: "Unauthorized" }, 401);
    },
  });
  await client.login();

  const ids = Array.from({ length: 100 }, (_, i) => 900_000 + i);
  const { abortedForAuthorization } = await fetchGalleriesBounded(client, ids, { concurrency: 5 });

  assert.equal(abortedForAuthorization, true);
  const detailCalls = calls.filter((u) => u.includes("/api/product/"));
  assert.ok(detailCalls.length < ids.length, "traversal stopped early");
});
