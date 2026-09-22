import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GALLERY_STATE_HTTP_URL_ENV,
  GALLERY_STATE_SECRET_ENV,
  createConvexGalleryStateStore,
  validateGalleryStateConfig,
} from "../gallery-state-convex-store.mjs";
import { parseBootstrapArtifact, planGalleryRefresh } from "../gallery-state.mjs";

// OFFLINE. These assert how scrape.mjs is wired and what its configuration
// validation does. Nothing here spawns the scraper, contacts Koff, or touches
// a deployment.

const SCRAPE = readFileSync(new URL("../scrape.mjs", import.meta.url), "utf8");
const SITE_URL = "https://example-deployment.eu-west-1.convex.site";
const SECRET = "fixture-only-secret-value-32-characters";

// ==========================================================================
// 1-3. Fail-closed configuration
// ==========================================================================

test("1. gallery enabled with no HTTP URL fails validation", () => {
  const { ok, errors } = validateGalleryStateConfig({ httpAddress: undefined, secret: SECRET, httpActionsUrl: undefined });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes(GALLERY_STATE_HTTP_URL_ENV)), errors.join("; "));
  assert.ok(errors.every((e) => !e.includes(SECRET)), "no value may appear in an error");
});

test("2. gallery enabled with no secret fails validation", () => {
  const { ok, errors } = validateGalleryStateConfig({ httpActionsUrl: SITE_URL });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes(GALLERY_STATE_SECRET_ENV)), errors.join("; "));
});

test("2b. both missing reports both, and neither value leaks", () => {
  const { ok, errors } = validateGalleryStateConfig({});
  assert.equal(ok, false);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.includes(GALLERY_STATE_HTTP_URL_ENV)));
  assert.ok(errors.some((e) => e.includes(GALLERY_STATE_SECRET_ENV)));
});

test("3. complete configuration validates", () => {
  const { ok, errors } = validateGalleryStateConfig({ httpActionsUrl: SITE_URL, secret: SECRET });
  assert.equal(ok, true);
  assert.deepEqual(errors, []);
});

test("3b. validation runs BEFORE the Koff login in scrape.mjs", () => {
  // The ordering is the whole safety property: an unconfigured durable store
  // must stop the run before a single Koff request is made.
  const validationAt = SCRAPE.indexOf("validateGalleryStateConfig(");
  const loginAt = SCRAPE.indexOf("koffClient.login()");
  assert.notEqual(validationAt, -1, "scrape.mjs must validate gallery config");
  assert.notEqual(loginAt, -1, "scrape.mjs must log in to Koff");
  assert.ok(validationAt < loginAt, "gallery config must be validated before Koff login");

  // And it is gated on the opt-in flag, so a gallery-off run needs neither var.
  const guardAt = SCRAPE.lastIndexOf("if (ENABLE_GALLERY_FETCH) {", validationAt);
  assert.notEqual(guardAt, -1, "validation must sit inside the ENABLE_GALLERY_FETCH guard");
});

test("3c. a gallery-disabled run requires neither gallery variable", () => {
  // The guard means the config is only demanded when the flag is on. Assert the
  // shape of the guard rather than running the scraper.
  assert.match(SCRAPE, /if \(ENABLE_GALLERY_FETCH\) \{\s*\n\s*const \{ ok, errors \} = validateGalleryStateConfig\(/);
});

// ==========================================================================
// 4-7. Store wiring
// ==========================================================================

test("4. the live gallery runtime uses the durable Convex store", () => {
  assert.match(SCRAPE, /createConvexGalleryStateStore\(\{/);
  assert.match(SCRAPE, /httpActionsUrl: GALLERY_STATE_HTTP_URL/);
  assert.match(SCRAPE, /secret: GALLERY_STATE_SECRET/);
});

test("5. the live gallery runtime does NOT use the file store", () => {
  assert.doesNotMatch(SCRAPE, /createFileGalleryStateStore/, "the file store must not be in the live path");
  assert.doesNotMatch(SCRAPE, /GALLERY_STATE_FILE/, "the obsolete file-state variable must be gone");
  assert.doesNotMatch(SCRAPE, /koff-gallery-state\.json/, "no leftover file-state path");
});

test("6. a .convex.cloud URL is rejected for the gallery boundary", () => {
  const { ok, errors } = validateGalleryStateConfig({
    httpActionsUrl: "https://some-deployment.eu-west-1.convex.cloud",
    secret: SECRET,
  });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /convex\.site/.test(e)), errors.join("; "));
});

test("7. a .convex.site URL is accepted", () => {
  const { ok } = validateGalleryStateConfig({ httpActionsUrl: SITE_URL, secret: SECRET });
  assert.equal(ok, true);
});

test("7b. a non-https URL is rejected", () => {
  const { ok, errors } = validateGalleryStateConfig({ httpActionsUrl: "http://insecure.example", secret: SECRET });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /https/.test(e)));
});

test("7c. the store constructor rejects the same bad configurations", () => {
  assert.throws(
    () => createConvexGalleryStateStore({ httpActionsUrl: "https://x.eu-west-1.convex.cloud", secret: SECRET }),
    /convex\.site/
  );
  assert.throws(() => createConvexGalleryStateStore({ httpActionsUrl: SITE_URL }), new RegExp(GALLERY_STATE_SECRET_ENV));
});

// ==========================================================================
// 8-10. Incremental behaviour through the real store interface
// ==========================================================================

/** Fake authenticated boundary, as the store expects. */
function fakeBoundary(expectedSecret = SECRET) {
  const rows = new Map();
  let meta = null;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const supplied = options?.headers?.["x-koff-gallery-state-secret"];
    calls.push({ path, supplied });
    if (!expectedSecret || !supplied || supplied !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = options?.body ? JSON.parse(options.body) : {};
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "/gallery-state/meta/read") return json({ meta });
    if (path === "/gallery-state/page") {
      const all = [...rows.values()].sort((a, b) => a.sourceProductId - b.sourceProductId);
      const start = body.cursor ? Number(body.cursor) : 0;
      const page = all.slice(start, start + 500);
      const next = start + page.length;
      return json({ page, isDone: next >= all.length, continueCursor: next >= all.length ? null : String(next) });
    }
    if (path === "/gallery-state/batch") {
      for (const r of body.rows) rows.set(r.sourceProductId, { ...r });
      return json({ ok: true, inserted: body.rows.length, updated: 0 });
    }
    if (path === "/gallery-state/meta/write") {
      meta = { ...body };
      return json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  };
  return { fetchImpl, rows, calls, getMeta: () => meta };
}

const CATALOG_SIZE = 1000;
const BASE_ID = 500_000;

function catalog() {
  return Array.from({ length: CATALOG_SIZE }, (_, i) => ({
    sourceProductId: BASE_ID + i,
    imageUrl: `https://cdn.koff.ro/img/${i}.webp`,
  }));
}

function seededRows(cat) {
  return cat.map((p) => ({
    sourceProductId: p.sourceProductId,
    sourceId: `KF${p.sourceProductId}`,
    coverIdentity: p.imageUrl,
    galleryUrls: [p.imageUrl, `${p.imageUrl}?alt`],
    galleryFingerprint: "fp",
    lastSuccessfulFetchAt: 1,
    lastAttemptAt: 1,
    lastFailureAt: null,
    failureCount: 0,
    status: "ready",
  }));
}

test("8. unchanged durable state selects zero candidates", () => {
  const cat = catalog();
  const plan = planGalleryRefresh({
    catalog: cat,
    stateRows: seededRows(cat),
    meta: { schemaVersion: 1, bootstrapCompleted: true, bootstrapRunId: "35607622806", bootstrapCompletedAt: 1, updatedAt: 1 },
  });
  assert.equal(plan.abort, false);
  assert.equal(plan.candidates.length, 0, "no detail requests for unchanged state");
});

test("9. unchanged durable state still supplies the cached gallery", async () => {
  // This is what makes the exported catalog whole even at zero detail requests.
  const { runIncrementalGalleryPass } = await import("../gallery-state-store.mjs");
  const cat = catalog();
  const boundary = fakeBoundary();
  const store = createConvexGalleryStateStore({ httpActionsUrl: SITE_URL, secret: SECRET, fetchImpl: boundary.fetchImpl });

  const rows = seededRows(cat);
  for (let i = 0; i < rows.length; i += 200) {
    await store.save({ meta: { schemaVersion: 1, bootstrapCompleted: true, bootstrapRunId: "35607622806", bootstrapCompletedAt: 1, updatedAt: 1 }, rows: rows.slice(i, i + 200) });
  }

  const fetched = [];
  await runIncrementalGalleryPass({
    store,
    catalog: cat,
    now: 2,
    fetchGalleries: async (ids) => {
      fetched.push([...ids]);
      return { galleries: new Map() };
    },
  });

  assert.deepEqual(fetched, [], "no fetch at all");

  // The caller (scrape.mjs) reads cached state back to populate product.images.
  const state = await store.load();
  const first = state.rows.find((r) => r.sourceProductId === BASE_ID);
  assert.deepEqual(first.galleryUrls, [`${cat[0].imageUrl}`, `${cat[0].imageUrl}?alt`]);
});

test("10. only the candidate reaches the fetch step", async () => {
  const { runIncrementalGalleryPass } = await import("../gallery-state-store.mjs");
  const cat = catalog();
  const boundary = fakeBoundary();
  const store = createConvexGalleryStateStore({ httpActionsUrl: SITE_URL, secret: SECRET, fetchImpl: boundary.fetchImpl });

  const rows = seededRows(cat);
  await store.save({ meta: { schemaVersion: 1, bootstrapCompleted: true, bootstrapRunId: "35607622806", bootstrapCompletedAt: 1, updatedAt: 1 }, rows });

  const newcomer = { sourceProductId: 999_999, imageUrl: "https://cdn.koff.ro/img/new.webp" };
  const fetched = [];
  const outcome = await runIncrementalGalleryPass({
    store,
    catalog: [...cat, newcomer],
    now: 2,
    fetchGalleries: async (ids) => {
      fetched.push([...ids]);
      return { galleries: new Map(ids.map((id) => [id, { ok: true, images: ["https://cdn.koff.ro/img/x.webp"] }])) };
    },
  });

  assert.deepEqual(fetched, [[999_999]], "exactly the one new product");
  assert.deepEqual(outcome.plan.candidates, [{ sourceProductId: 999_999, reason: "no-state-row" }]);
});

// ==========================================================================
// 11-12. Guards preserved
// ==========================================================================

test("11. the mass guard is still active and still aborts before fetching", async () => {
  const { runIncrementalGalleryPass } = await import("../gallery-state-store.mjs");
  const cat = catalog();
  const boundary = fakeBoundary();
  const store = createConvexGalleryStateStore({ httpActionsUrl: SITE_URL, secret: SECRET, fetchImpl: boundary.fetchImpl });
  await store.save({ meta: { schemaVersion: 1, bootstrapCompleted: true, bootstrapRunId: "35607622806", bootstrapCompletedAt: 1, updatedAt: 1 }, rows: [] });

  let called = 0;
  const outcome = await runIncrementalGalleryPass({
    store,
    catalog: cat,
    now: 2,
    fetchGalleries: async () => {
      called++;
      return { galleries: new Map() };
    },
  });

  assert.equal(outcome.plan.abort, true, "empty state against a full catalog must abort");
  assert.equal(outcome.plan.candidates.length, 0);
  assert.equal(called, 0, "the fetch step was never reached");
});

test("12. FULL_GALLERY_REFRESH is false by default in scrape.mjs", () => {
  assert.match(SCRAPE, /const FULL_GALLERY_REFRESH = process\.env\.FULL_GALLERY_REFRESH === "true";/);
  assert.doesNotMatch(SCRAPE, /FULL_GALLERY_REFRESH\s*=\s*true/);
});

// ==========================================================================
// 13-14. Policy and no hard-coded configuration
// ==========================================================================

test("13. the authorization latch is still wired", () => {
  assert.match(SCRAPE, /abortedForAuthorization/, "scrape.mjs must surface the auth latch");
  assert.match(SCRAPE, /fetchGalleriesBounded\(koffClient/, "still the hardened pool");
});

test("14. no deployment URL or secret is hard-coded in scrape.mjs", () => {
  // A REAL deployment host looks like `https://<adj>-<noun>-<digits>....convex.site`.
  // The pre-existing `https://xxxxx.convex.site` placeholder in a comment is
  // not a deployment and must not trip this.
  assert.doesNotMatch(
    SCRAPE,
    /https:\/\/[a-z]+-[a-z]+-\d{3}\./,
    "no hard-coded deployment URL"
  );
  assert.doesNotMatch(SCRAPE, /[a-z]+-[a-z]+-\d{3}/, "no hard-coded deployment id");
  assert.doesNotMatch(SCRAPE, new RegExp(`${GALLERY_STATE_SECRET_ENV}\\s*=\\s*["'][^"']+["']`), "no hard-coded secret");
  // Both come from the environment, by name.
  assert.match(SCRAPE, new RegExp(`process\\.env\\.${GALLERY_STATE_HTTP_URL_ENV}`));
  assert.match(SCRAPE, new RegExp(`process\\.env\\.${GALLERY_STATE_SECRET_ENV}`));
});

test("14b. the safety policy values are unchanged", () => {
  assert.match(SCRAPE, /: 5;/); // gallery concurrency default
  const koff = readFileSync(new URL("../koff-client.mjs", import.meta.url), "utf8");
  assert.match(koff, /const DEFAULT_MIN_REQUEST_INTERVAL_MS = 500;/);
  assert.match(koff, /const MAX_RETRIES = 3;/);
  assert.match(koff, /const RETRYABLE_STATUSES = new Set\(\[429, 502, 503, 504\]\);/);
});
