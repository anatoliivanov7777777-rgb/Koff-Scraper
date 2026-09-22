import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  GALLERY_STATUS,
  computeGalleryFingerprint,
  createGalleryMeta,
  isGalleryMetaUsable,
  normalizeCoverIdentity,
  parseBootstrapArtifact,
  planGalleryRefresh,
} from "../gallery-state.mjs";
import { createConvexGalleryStateStore } from "../gallery-state-convex-store.mjs";
import { runIncrementalGalleryPass } from "../gallery-state-store.mjs";

// OFFLINE. The Convex client is a fake with the same query()/mutation() shape,
// so the adapter's batching, ordering and round-trip behaviour is exercised
// without a deployment, a credential or a socket.

const NOW = 1_700_000_000_000;
const RUN_ID = "35607622806";
const PAGE_SIZE = 500;

/**
 * A fake Convex deployment: real table semantics (upsert by sourceProductId,
 * paginated reads, a single meta row) so the adapter is tested against
 * behaviour rather than against call transcripts alone.
 */
function fakeConvex({ pageSize = PAGE_SIZE } = {}) {
  const rows = new Map();
  let meta = null;
  const calls = [];
  const state = {
    rows,
    getMeta: () => meta,
    setMetaRaw: (m) => { meta = m; },
    calls,
    insertCalls: () => calls.filter((c) => c.name === "galleryState:upsertGalleryStateBatch"),
    metaCalls: () => calls.filter((c) => c.name === "galleryState:setGalleryMeta"),
  };

  return {
    ...state,
    client: {
      async query(name, args) {
        calls.push({ kind: "query", name, args });
        if (name === "galleryState:getGalleryMeta") return meta;
        if (name === "galleryState:getGalleryStateStats") {
          let images = 0;
          for (const row of rows.values()) images += row.galleryUrls.length;
          return { count: rows.size, images };
        }
        if (name === "galleryState:getGalleryStatePage") {
          const all = [...rows.values()].sort((a, b) => a.sourceProductId - b.sourceProductId);
          const start = args.cursor ? Number(args.cursor) : 0;
          const size = Math.min(args.numItems ?? pageSize, pageSize);
          const page = all.slice(start, start + size);
          const next = start + page.length;
          const done = next >= all.length;
          return { page, isDone: done, continueCursor: done ? null : String(next) };
        }
        throw new Error(`unexpected query ${name}`);
      },
      async mutation(name, args) {
        calls.push({ kind: "mutation", name, args });
        if (name === "galleryState:upsertGalleryStateBatch") {
          let inserted = 0;
          let updated = 0;
          for (const row of args.rows) {
            if (rows.has(row.sourceProductId)) updated++;
            else inserted++;
            rows.set(row.sourceProductId, { ...row });
          }
          return { inserted, updated, processed: args.rows.length };
        }
        if (name === "galleryState:setGalleryMeta") {
          meta = {
            schemaVersion: args.schemaVersion,
            bootstrapCompleted: args.bootstrapCompleted,
            bootstrapRunId: args.bootstrapRunId ?? null,
            bootstrapCompletedAt: args.bootstrapCompletedAt ?? null,
            updatedAt: args.updatedAt,
          };
          return { updated: true };
        }
        throw new Error(`unexpected mutation ${name}`);
      },
    },
  };
}

/** A compact stand-in for the real artifact: enough rows to force pages+batches. */
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

/** Deterministic summary of persisted state, for exact round-trip comparison. */
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

// --------------------------------------------------------------------------
// Batching
// --------------------------------------------------------------------------

test("convex store: bootstrap writes in bounded batches, not one giant mutation", async () => {
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1200), { now: NOW, runId: RUN_ID });

  const result = await store.bootstrap({ rows, meta });

  assert.equal(result.written, 1200);
  assert.equal(result.batches, 6, "1200 rows / 200 per batch");
  assert.equal(fake.insertCalls().length, 6);
  for (const call of fake.insertCalls()) {
    assert.ok(call.args.rows.length <= 200, "no batch exceeds the bound");
  }
  assert.equal(fake.rows.size, 1200);
});

test("convex store: the default batch size is bounded", async () => {
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(700), { now: NOW, runId: RUN_ID });
  await store.bootstrap({ rows, meta });
  for (const call of fake.insertCalls()) {
    assert.ok(call.args.rows.length <= 500, "a single mutation stays small");
  }
  assert.ok(fake.insertCalls().length >= 2, "700 rows do not fit one mutation");
});

test("convex store: bootstrap is idempotent - a second run updates, never duplicates", async () => {
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(400), { now: NOW, runId: RUN_ID });

  await store.bootstrap({ rows, meta });
  const second = await store.bootstrap({ rows, meta });

  assert.equal(fake.rows.size, 400, "still 400 rows, not 800");
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 400);
});

// --------------------------------------------------------------------------
// Ordering: meta is written LAST
// --------------------------------------------------------------------------

test("convex store: bootstrap writes every row BEFORE declaring the state complete", async () => {
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1000), { now: NOW, runId: RUN_ID });

  await store.bootstrap({ rows, meta });

  const names = fake.calls.map((c) => c.name);
  const lastInsert = names.lastIndexOf("galleryState:upsertGalleryStateBatch");
  const metaWrite = names.indexOf("galleryState:setGalleryMeta");
  assert.ok(metaWrite > lastInsert, "setGalleryMeta must come after the final row batch");
  assert.equal(fake.getMeta().bootstrapCompleted, true);
  assert.equal(fake.getMeta().bootstrapRunId, RUN_ID);
});

test("convex store: a failure before the meta write leaves the state NOT bootstrapped", async () => {
  const fake = fakeConvex();
  // Fail the second row batch, i.e. part-way through the import.
  let batches = 0;
  const client = {
    query: fake.client.query,
    mutation: async (name, args) => {
      if (name === "galleryState:upsertGalleryStateBatch") {
        batches++;
        if (batches === 2) throw new Error("deployment went away");
      }
      return await fake.client.mutation(name, args);
    },
  };
  const store = createConvexGalleryStateStore({ client, batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1000), { now: NOW, runId: RUN_ID });

  await assert.rejects(() => store.bootstrap({ rows, meta }), /deployment went away/);

  // The important part: no meta was written, so the next run ABORTS rather
  // than treating a half-imported state as complete.
  assert.equal(fake.getMeta(), null);
  const loaded = await store.load();
  assert.equal(isGalleryMetaUsable(loaded.meta), false, "incomplete import must not look usable");
});

// --------------------------------------------------------------------------
// Load / save round trip
// --------------------------------------------------------------------------

test("convex store: load() walks pages instead of asking for every row at once", async () => {
  const fake = fakeConvex({ pageSize: 500 });
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200, pageSize: 500 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(1200), { now: NOW, runId: RUN_ID });
  await store.bootstrap({ rows, meta });

  const loaded = await store.load();

  assert.equal(loaded.rows.length, 1200);
  const pageCalls = fake.calls.filter((c) => c.name === "galleryState:getGalleryStatePage");
  assert.ok(pageCalls.length >= 3, `expected multiple pages, saw ${pageCalls.length}`);
  for (const call of pageCalls) {
    assert.ok((call.args.numItems ?? 0) <= 1000, "a page request stays bounded");
  }
});

test("convex store: an empty deployment reports unusable meta, never 'no state means fetch all'", async () => {
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client });

  const loaded = await store.load();
  assert.equal(loaded.meta, null);
  assert.deepEqual(loaded.rows, []);
  assert.equal(isGalleryMetaUsable(loaded.meta), false);

  const catalog = artifactFixture(1000).map((p) => ({ sourceProductId: p.sourceProductId, imageUrl: p.imageUrl }));
  const plan = planGalleryRefresh({ catalog, stateRows: loaded.rows, meta: loaded.meta });
  assert.equal(plan.abort, true, "a fresh deployment aborts rather than fetching everything");
  assert.deepEqual(plan.candidates, []);
});

test("convex store: stats report the persisted row and gallery-url counts", async () => {
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200 });
  const { rows, meta } = parseBootstrapArtifact(artifactFixture(600), { now: NOW, runId: RUN_ID });
  await store.bootstrap({ rows, meta });

  const stats = await store.stats();
  assert.equal(stats.count, 600);
  assert.equal(stats.images, 1800, "3 urls per row");
});

// --------------------------------------------------------------------------
// Round-trip fidelity
// --------------------------------------------------------------------------

test("round trip: persisted state matches the artifact exactly", async () => {
  const fixture = artifactFixture(1500);
  const parsed = parseBootstrapArtifact(fixture, { now: NOW, runId: RUN_ID });
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200 });

  await store.bootstrap({ rows: parsed.rows, meta: parsed.meta });
  const loaded = await store.load();

  // Row count, id set, and full payload identity - not just counts.
  assert.equal(loaded.rows.length, parsed.rows.length);
  assert.deepEqual(
    loaded.rows.map((r) => r.sourceProductId).sort((a, b) => a - b),
    parsed.rows.map((r) => r.sourceProductId).sort((a, b) => a - b)
  );
  assert.equal(stateChecksum(loaded.rows), stateChecksum(parsed.rows), "zero mismatches");

  // Spot-check the fields the task calls out explicitly.
  for (const expected of parsed.rows.slice(0, 25)) {
    const actual = loaded.rows.find((r) => r.sourceProductId === expected.sourceProductId);
    assert.equal(actual.sourceId, expected.sourceId);
    assert.equal(actual.coverIdentity, expected.coverIdentity);
    assert.deepEqual(actual.galleryUrls, expected.galleryUrls);
    assert.equal(actual.galleryFingerprint, expected.galleryFingerprint);
    assert.equal(actual.status, GALLERY_STATUS.READY);
  }
});

test("round trip: fingerprints are recomputable from the persisted urls", async () => {
  const parsed = parseBootstrapArtifact(artifactFixture(50), { now: NOW, runId: RUN_ID });
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client });
  await store.bootstrap({ rows: parsed.rows, meta: parsed.meta });

  const loaded = await store.load();
  for (const row of loaded.rows) {
    assert.equal(row.galleryFingerprint, computeGalleryFingerprint(row.galleryUrls));
    assert.equal(row.coverIdentity, normalizeCoverIdentity(row.coverIdentity), "cover stored normalized");
  }
});

// --------------------------------------------------------------------------
// The whole point: a bootstrapped deployment needs no full refresh
// --------------------------------------------------------------------------

test("convex store: after bootstrap, the next run makes ZERO detail requests", async () => {
  const fixture = artifactFixture(1000);
  const parsed = parseBootstrapArtifact(fixture, { now: NOW, runId: RUN_ID });
  const fake = fakeConvex();
  const store = createConvexGalleryStateStore({ client: fake.client, batchSize: 200 });
  await store.bootstrap({ rows: parsed.rows, meta: parsed.meta });

  // Next run: the same snapshot's catalog, plus one genuinely new product.
  const newcomer = { sourceProductId: 999_999, imageUrl: "https://cdn.koff.ro/img/new/cover.webp" };
  const catalog = [
    ...fixture.map((p) => ({ sourceProductId: p.sourceProductId, imageUrl: p.imageUrl })),
    newcomer,
  ];

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

  // 1001 rows now, and the meta timestamp advanced.
  const reloaded = await store.load();
  assert.equal(reloaded.rows.length, 1001);
  assert.equal(reloaded.meta.updatedAt, NOW + 86_400_000);
  assert.equal(reloaded.meta.bootstrapCompleted, true, "the bootstrap flag survives an incremental save");
  assert.equal(reloaded.meta.bootstrapRunId, RUN_ID);
});

// --------------------------------------------------------------------------
// Guardrails
// --------------------------------------------------------------------------

test("convex store: a missing or malformed client is rejected, not silently ignored", () => {
  assert.throws(() => createConvexGalleryStateStore({}), /Convex client/);
  assert.throws(() => createConvexGalleryStateStore({ client: {} }), /Convex client/);
  assert.throws(() => createConvexGalleryStateStore({ client: { query() {} } }), /Convex client/);
});

test("the convex adapter contains no deployment URL and no Koff endpoint", () => {
  const storeSource = readFileSync(new URL("../gallery-state-convex-store.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(storeSource, /koff\.ro/, "no supplier endpoint in the persistence layer");
  assert.doesNotMatch(storeSource, /\.convex\.(cloud|site)/, "no hard-coded deployment");
  // The planner stays the only policy layer.
  assert.doesNotMatch(storeSource, /planGalleryRefresh/);
  const plannerSource = readFileSync(new URL("../gallery-state.mjs", import.meta.url), "utf8");
  assert.match(plannerSource, /export function planGalleryRefresh/);
});

test("the convex schema still declares galleryState keyed by sourceProductId", () => {
  const schema = readFileSync(new URL("../../convex/schema.ts", import.meta.url), "utf8");
  assert.match(schema, /galleryState: defineTable\(/);
  assert.match(schema, /\.index\("by_sourceProductId", \["sourceProductId"\]\)/);
  assert.match(schema, /galleryMeta: defineTable\(/);
});
