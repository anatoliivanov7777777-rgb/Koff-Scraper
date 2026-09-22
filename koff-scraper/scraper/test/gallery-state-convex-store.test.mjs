import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  GALLERY_STATUS,
  computeGalleryFingerprint,
  isGalleryMetaUsable,
  normalizeCoverIdentity,
  parseBootstrapArtifact,
  planGalleryRefresh,
} from "../gallery-state.mjs";
import {
  GALLERY_STATE_SECRET_ENV,
  GALLERY_STATE_SECRET_HEADER,
  createConvexGalleryStateStore,
} from "../gallery-state-convex-store.mjs";
import { runIncrementalGalleryPass } from "../gallery-state-store.mjs";

// OFFLINE. `fetchImpl` is injected, so the adapter's real header handling and
// batching are exercised against a fake deployment - no socket, no credential,
// no live Convex project.

const NOW = 1_700_000_000_000;
const RUN_ID = "35607622806";
const URL_BASE = "https://example-deployment.convex.site";
const SECRET = "fixture-only-gallery-state-secret-32-chars";

/**
 * A fake Convex HTTP boundary that enforces the SAME rules the real one does:
 * a configured secret, the required header, and equality. If the adapter ever
 * stopped sending the header, these tests would fail the way production would.
 */
function fakeBoundary({ expectedSecret = SECRET, pageSize = 500 } = {}) {
  const rows = new Map();
  let meta = null;
  const calls = [];

  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const supplied = options?.headers?.[GALLERY_STATE_SECRET_HEADER];
    calls.push({ path, supplied, body: options?.body ? JSON.parse(options.body) : null });

    // Fail-closed exactly like http.ts.
    if (!expectedSecret) return new Response("Unauthorized", { status: 401 });
    if (!supplied || supplied !== expectedSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const body = options?.body ? JSON.parse(options.body) : {};
    const json = (b, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

    if (path === "/gallery-state/meta/read") return json({ meta });
    if (path === "/gallery-state/page") {
      const all = [...rows.values()].sort((a, b) => a.sourceProductId - b.sourceProductId);
      const start = body.cursor ? Number(body.cursor) : 0;
      const size = Math.min(body.numItems ?? pageSize, pageSize);
      const page = all.slice(start, start + size);
      const next = start + page.length;
      const done = next >= all.length;
      return json({ page, isDone: done, continueCursor: done ? null : String(next) });
    }
    if (path === "/gallery-state/batch") {
      if (!Array.isArray(body.rows) || body.rows.length === 0) return new Response("No rows", { status: 400 });
      if (body.rows.length > 500) return new Response("Batch too large", { status: 413 });
      let inserted = 0, updated = 0;
      for (const row of body.rows) {
        if (rows.has(row.sourceProductId)) updated++; else inserted++;
        rows.set(row.sourceProductId, { ...row });
      }
      return json({ ok: true, inserted, updated, processed: body.rows.length });
    }
    if (path === "/gallery-state/meta/write") {
      meta = {
        schemaVersion: body.schemaVersion,
        bootstrapCompleted: body.bootstrapCompleted === true,
        bootstrapRunId: body.bootstrapRunId ?? null,
        bootstrapCompletedAt: body.bootstrapCompletedAt ?? null,
        updatedAt: body.updatedAt,
      };
      return json({ ok: true, updated: true });
    }
    return new Response("Not found", { status: 404 });
  };

  return {
    fetchImpl,
    calls,
    rows,
    getMeta: () => meta,
    batchCalls: () => calls.filter((c) => c.path === "/gallery-state/batch"),
    paths: () => calls.map((c) => c.path),
  };
}

function artifactFixture(count = 1200) {
  return Array.from({ length: count }, (_, i) => ({
    sourceProductId: 400_000 + i,
    sourceId: `KF${9000000 + i}`,
    imageUrl: `https://cdn.koff.ro/img/${i}/cover.webp`,
    images: [
      `https://cdn.koff.ro/img/${i}/cover.webp`,
      `https://cdn.koff.ro/img/${i}/alt-1.webp`,
      `https://cdn.koff.ro/img/${i}/alt-2.webp`,
    ],
  }));
}

function stateChecksum(rows) {
  const normalized = [...rows]
    .map((r) => ({
      id: r.sourceProductId,
      sourceId: r.sourceId ?? null,
      cover: r.coverIdentity ?? null,
      urls: [...r.galleryUrls],
      fp: r.galleryFingerprint ?? null,
      status: r.status,
    }))
    .sort((a, b) => a.id - b.id);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

const storeFor = (boundary, extra = {}) =>
  createConvexGalleryStateStore({ httpActionsUrl: URL_BASE, secret: SECRET, fetchImpl: boundary.fetchImpl, ...extra });

// ==========================================================================
// 1-4. Authentication
// ==========================================================================

test("1. a server with no configured secret denies every write", async () => {
  const boundary = fakeBoundary({ expectedSecret: null });
  const store = storeFor(boundary);
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(10), { now: NOW, runId: RUN_ID });

  await assert.rejects(() => store.bootstrap({ rows, meta }), /401/);
  assert.equal(boundary.rows.size, 0, "nothing was written");
  assert.equal(boundary.getMeta(), null, "meta was not written either");
});

test("2. a request without the secret header is denied", async () => {
  const boundary = fakeBoundary();
  // A store built with a blank secret cannot even be constructed - the point is
  // that no request leaves without the header.
  assert.throws(
    () => createConvexGalleryStateStore({ httpActionsUrl: URL_BASE, secret: "", fetchImpl: boundary.fetchImpl }),
    new RegExp(GALLERY_STATE_SECRET_ENV)
  );
});

test("2b. the adapter always sends the secret header", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary);
  await store.load();
  assert.ok(boundary.calls.length > 0);
  for (const call of boundary.calls) {
    assert.equal(call.supplied, SECRET, `missing header on ${call.path}`);
  }
});

test("3. a wrong secret is denied", async () => {
  const boundary = fakeBoundary({ expectedSecret: "a-different-secret-entirely" });
  const store = storeFor(boundary);
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(5), { now: NOW, runId: RUN_ID });

  await assert.rejects(() => store.bootstrap({ rows, meta }), /401/);
  assert.equal(boundary.rows.size, 0);
});

test("4. the correct secret is allowed", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary);
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(10), { now: NOW, runId: RUN_ID });

  const result = await store.bootstrap({ rows, meta });
  assert.equal(result.written, 10);
  assert.equal(boundary.rows.size, 10);
  assert.equal(boundary.getMeta().bootstrapCompleted, true);
});

test("5. the secret is never logged, echoed, or embedded in an error", async () => {
  const boundary = fakeBoundary({ expectedSecret: "the-real-secret-value" });
  const store = storeFor(boundary);
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(3), { now: NOW, runId: RUN_ID });

  let message = "";
  try {
    await store.bootstrap({ rows, meta });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  assert.match(message, /401/);
  assert.doesNotMatch(message, /the-real-secret-value/, "expected secret must not appear");
  assert.doesNotMatch(message, new RegExp(SECRET), "supplied secret must not appear");
  assert.doesNotMatch(message, new RegExp(GALLERY_STATE_SECRET_HEADER), "header name must not be echoed");
});

// ==========================================================================
// 6. The Convex surface is not publicly writable
// ==========================================================================

test("6. gallery state functions are internal, not public mutations", () => {
  const source = readFileSync(new URL("../../convex/galleryState.ts", import.meta.url), "utf8");

  // Every exported function must be internalQuery/internalMutation.
  const exported = source.match(/export const \w+ = (\w+)\(/g) ?? [];
  assert.ok(exported.length >= 4, `expected the gallery functions, saw ${exported.length}`);
  for (const line of exported) {
    assert.match(line, /internal(Query|Mutation)\(/, `publicly exposed: ${line}`);
  }
  // And none of the public builders appear at all.
  assert.doesNotMatch(source, /=\s*query\(/);
  assert.doesNotMatch(source, /=\s*mutation\(/);
});

test("6b. the full-table stats query does not exist anywhere", () => {
  const source = readFileSync(new URL("../../convex/galleryState.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /getGalleryStateStats/, "the unsafe aggregate query must be gone");
  assert.doesNotMatch(source, /for await \(const row of ctx\.db\.query/, "no unbounded server scan");
});

// ==========================================================================
// 7-10. Each HTTP operation requires authentication
// ==========================================================================

test("7-10. every gallery-state route is secret-checked in http.ts", () => {
  const source = readFileSync(new URL("../../convex/http.ts", import.meta.url), "utf8");

  for (const path of [
    "/gallery-state/meta/read",
    "/gallery-state/page",
    "/gallery-state/batch",
    "/gallery-state/meta/write",
  ]) {
    const at = source.indexOf(`path: "${path}"`);
    assert.notEqual(at, -1, `${path} is not routed`);
    // The guard must be the first thing in that handler.
    const handlerBody = source.slice(at, at + 400);
    assert.match(handlerBody, /if \(!galleryStateAuthorized\(request\)\) return unauthorized\(\);/,
      `${path} is not authenticated`);
  }

  // The boundary calls internal functions only.
  assert.doesNotMatch(source, /ctx\.runQuery\(api\.galleryState/);
  assert.doesNotMatch(source, /ctx\.runMutation\(api\.galleryState/);
  assert.match(source, /internal\.galleryState\./);
});

test("7b-10b. the adapter is denied on every operation when the secret is wrong", async () => {
  const boundary = fakeBoundary({ expectedSecret: "correct-secret" });
  const store = createConvexGalleryStateStore({
    httpActionsUrl: URL_BASE,
    secret: "wrong-secret",
    fetchImpl: boundary.fetchImpl,
  });

  await assert.rejects(() => store.load(), /401/, "load must be denied");
  await assert.rejects(() => store.stats(), /401/, "stats must be denied");
  await assert.rejects(() => store.allRows(), /401/, "allRows must be denied");
  await assert.rejects(
    () => store.bootstrap({ rows: [{ sourceProductId: 1 }], meta: { schemaVersion: 1, updatedAt: NOW } }),
    /401/,
    "bootstrap must be denied"
  );
});

test("no deployment URL or secret value is committed in the adapter", () => {
  const store = readFileSync(new URL("../gallery-state-convex-store.mjs", import.meta.url), "utf8");
  // Written without naming any real deployment, so this file never records one.
  assert.doesNotMatch(store, /https:\/\/[a-z0-9-]+\.convex\.(cloud|site)/, "no hard-coded deployment URL");
  assert.doesNotMatch(store, /[a-z]+-[a-z]+-\d{3}/, "no hard-coded deployment id");
  // The secret only ever comes from the injected parameter / its env var name.
  assert.match(store, new RegExp(GALLERY_STATE_SECRET_ENV));
});

// ==========================================================================
// 11. Batching stays bounded
// ==========================================================================

test("11. writes are bounded batches, never one giant mutation", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary, { batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1200), { now: NOW, runId: RUN_ID });

  const result = await store.bootstrap({ rows, meta });

  assert.equal(result.written, 1200);
  assert.equal(result.batches, 6, "1200 rows / 200 per batch");
  for (const call of boundary.batchCalls()) {
    assert.ok(call.body.rows.length <= 200, "no batch exceeds the bound");
  }
});

test("11b. the default batch size is bounded", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary);
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(700), { now: NOW, runId: RUN_ID });
  await store.bootstrap({ rows, meta });
  for (const call of boundary.batchCalls()) {
    assert.ok(call.body.rows.length <= 500, "a single mutation stays small");
  }
  assert.ok(boundary.batchCalls().length >= 2, "700 rows do not fit one mutation");
});

// ==========================================================================
// 12. Stats use pagination, not one full-table query
// ==========================================================================

test("12. stats walk pages on the client instead of one server-side aggregate", async () => {
  const boundary = fakeBoundary({ pageSize: 500 });
  const store = storeFor(boundary, { batchSize: 200, pageSize: 500 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1200), { now: NOW, runId: RUN_ID });
  await store.bootstrap({ rows, meta });

  boundary.calls.length = 0;
  const stats = await store.stats();

  assert.equal(stats.count, 1200);
  assert.equal(stats.images, 3600, "3 urls per row");
  const pageCalls = boundary.calls.filter((c) => c.path === "/gallery-state/page");
  assert.ok(pageCalls.length >= 3, `expected multiple page reads, saw ${pageCalls.length}`);
  for (const call of pageCalls) {
    assert.ok((call.body.numItems ?? 0) <= 1000, "each page request stays bounded");
  }
  // No stats route exists at all - that is the point.
  assert.equal(boundary.paths().filter((p) => p.includes("stats")).length, 0);
});

// ==========================================================================
// Ordering, idempotency, round trip
// ==========================================================================

test("meta is written AFTER the rows, never before", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary, { batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1000), { now: NOW, runId: RUN_ID });
  await store.bootstrap({ rows, meta });

  const paths = boundary.paths();
  const lastBatch = paths.lastIndexOf("/gallery-state/batch");
  const metaWrite = paths.indexOf("/gallery-state/meta/write");
  assert.ok(metaWrite > lastBatch, "meta write must come after the final row batch");
});

test("a failure before the meta write leaves the state NOT bootstrapped", async () => {
  const boundary = fakeBoundary();
  let batches = 0;
  const flakyFetch = async (url, options) => {
    if (new URL(url).pathname === "/gallery-state/batch") {
      batches++;
      if (batches === 2) throw new Error("deployment went away");
    }
    return await boundary.fetchImpl(url, options);
  };
  const store = createConvexGalleryStateStore({
    httpActionsUrl: URL_BASE,
    secret: SECRET,
    fetchImpl: flakyFetch,
    batchSize: 200,
  });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1000), { now: NOW, runId: RUN_ID });

  await assert.rejects(() => store.bootstrap({ rows, meta }), /deployment went away/);
  assert.equal(boundary.getMeta(), null, "meta must not be written after a partial import");
});

test("bootstrap is idempotent - a second run updates, never duplicates", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary, { batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(400), { now: NOW, runId: RUN_ID });

  await store.bootstrap({ rows, meta });
  const second = await store.bootstrap({ rows, meta });

  assert.equal(boundary.rows.size, 400, "still 400 rows, not 800");
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 400);
});

test("round trip: persisted state matches the artifact exactly", async () => {
  const fixture = artifactFixture(1500);
  const parsed = parseBootstrapArtifact(fixture, { now: NOW, runId: RUN_ID });
  const boundary = fakeBoundary();
  const store = storeFor(boundary, { batchSize: 200 });

  await store.bootstrap({ rows: parsed.rows, meta: parsed.meta });
  const loaded = await store.load();

  assert.equal(loaded.rows.length, parsed.rows.length);
  assert.equal(stateChecksum(loaded.rows), stateChecksum(parsed.rows), "zero mismatches");
  assert.equal(loaded.meta.bootstrapCompleted, true);
  assert.equal(loaded.meta.bootstrapRunId, RUN_ID);
  assert.equal(isGalleryMetaUsable(loaded.meta), true);

  for (const expected of parsed.rows.slice(0, 25)) {
    const actual = loaded.rows.find((r) => r.sourceProductId === expected.sourceProductId);
    assert.equal(actual.sourceId, expected.sourceId);
    assert.equal(actual.coverIdentity, expected.coverIdentity);
    assert.deepEqual(actual.galleryUrls, expected.galleryUrls);
    assert.equal(actual.galleryFingerprint, expected.galleryFingerprint);
    assert.equal(actual.galleryFingerprint, computeGalleryFingerprint(actual.galleryUrls));
    assert.equal(actual.status, GALLERY_STATUS.READY);
  }
});

// ==========================================================================
// The point: a bootstrapped deployment needs no full refresh
// ==========================================================================

test("after bootstrap, the next run makes ZERO detail requests", async () => {
  const fixture = artifactFixture(1000);
  const parsed = parseBootstrapArtifact(fixture, { now: NOW, runId: RUN_ID });
  const boundary = fakeBoundary();
  const store = storeFor(boundary, { batchSize: 200 });
  await store.bootstrap({ rows: parsed.rows, meta: parsed.meta });

  const newcomer = { sourceProductId: 999_999, imageUrl: "https://cdn.koff.ro/img/new/cover.webp" };
  const catalog = [...fixture.map((p) => ({ sourceProductId: p.sourceProductId, imageUrl: p.imageUrl })), newcomer];

  const fetched = [];
  const outcome = await runIncrementalGalleryPass({
    store,
    catalog,
    now: NOW + 86_400_000,
    fetchGalleries: async (ids) => {
      fetched.push([...ids]);
      return { galleries: new Map(ids.map((id) => [id, { ok: true, images: ["https://cdn.koff.ro/img/new/a.webp"] }])) };
    },
  });

  assert.equal(outcome.plan.abort, false);
  assert.deepEqual(outcome.plan.candidates, [{ sourceProductId: 999_999, reason: "no-state-row" }]);
  assert.deepEqual(fetched, [[999_999]], "only the new product was fetched");

  const reloaded = await store.load();
  assert.equal(reloaded.rows.length, 1001);
  assert.equal(reloaded.meta.bootstrapCompleted, true, "the bootstrap flag survives an incremental save");
});

test("an empty deployment reports unusable meta, never 'no state means fetch all'", async () => {
  const boundary = fakeBoundary();
  const store = storeFor(boundary);

  const loaded = await store.load();
  assert.equal(loaded.meta, null);
  assert.deepEqual(loaded.rows, []);
  assert.equal(isGalleryMetaUsable(loaded.meta), false);

  const catalog = artifactFixture(1000).map((p) => ({ sourceProductId: p.sourceProductId, imageUrl: p.imageUrl }));
  const plan = planGalleryRefresh({ catalog, stateRows: loaded.rows, meta: loaded.meta });
  assert.equal(plan.abort, true, "a fresh deployment aborts rather than fetching everything");
  assert.deepEqual(plan.candidates, []);
});

test("a missing or malformed configuration is rejected, not silently unauthenticated", () => {
  assert.throws(() => createConvexGalleryStateStore({}), /https URL/);
  assert.throws(() => createConvexGalleryStateStore({ httpActionsUrl: "http://insecure" }), /https URL/);
  assert.throws(() => createConvexGalleryStateStore({ httpActionsUrl: URL_BASE }), new RegExp(GALLERY_STATE_SECRET_ENV));
  assert.throws(
    () => createConvexGalleryStateStore({ httpActionsUrl: URL_BASE, secret: SECRET, fetchImpl: null }),
    /fetch implementation/
  );
  // The .convex.cloud host serves queries/mutations, not HTTP routes - using
  // it here is a silent 404, so it is rejected up front.
  assert.throws(
    () => createConvexGalleryStateStore({ httpActionsUrl: "https://x-abc-123.eu-west-1.convex.cloud", secret: SECRET }),
    /convex\.site/
  );
});
