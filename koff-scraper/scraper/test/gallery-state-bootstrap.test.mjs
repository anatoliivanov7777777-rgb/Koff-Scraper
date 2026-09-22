import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GALLERY_STATUS,
  computeGalleryFingerprint,
  isGalleryMetaUsable,
  parseBootstrapArtifact,
  planGalleryRefresh,
  summarizeGalleryState,
} from "../gallery-state.mjs";
import { createMemoryGalleryStateStore, runIncrementalGalleryPass } from "../gallery-state-store.mjs";

// OFFLINE. The bootstrap importer takes an already-captured artifact (the
// output of a previous gallery run) and never contacts Koff.

const NOW = 1_700_000_000_000;
const RUN_ID = "35607622806";

// A miniature stand-in for the verified artifact shape: the scraped catalog
// with per-product `images` arrays already resolved.
function artifactFixture() {
  return {
    products: [
      {
        sourceProductId: 371338,
        sourceId: "KF2365572",
        imageUrl: "https://cdn.koff.ro/img/cover-a.webp",
        images: ["https://cdn.koff.ro/img/a-1.webp", "https://cdn.koff.ro/img/a-2.webp"],
      },
      {
        sourceProductId: 388174,
        sourceId: "KF2365573",
        imageUrl: "https://cdn.koff.ro/img/cover-b.webp",
        images: ["https://cdn.koff.ro/img/b-1.webp"],
      },
      {
        // No gallery captured for this one - it must not become a bogus
        // "ready with zero images" row.
        sourceProductId: 388192,
        sourceId: "KF2365574",
        imageUrl: "https://cdn.koff.ro/img/cover-c.webp",
        images: [],
      },
    ],
  };
}

// --------------------------------------------------------------------------
// 17. The importer produces state without any Koff request
// --------------------------------------------------------------------------

test("17. the bootstrap artifact parser produces state without Koff requests", () => {
  const { rows, meta, stats } = parseBootstrapArtifact(artifactFixture(), { now: NOW, runId: RUN_ID });

  assert.equal(rows.length, 2, "the row with no images is not seeded");
  assert.equal(stats.totalImages, 3, "1 + 2 gallery images");
  assert.equal(stats.unusable, 1);

  const row = rows.find((r) => r.sourceProductId === 371338);
  assert.equal(row.status, GALLERY_STATUS.READY);
  assert.deepEqual(row.galleryUrls, ["https://cdn.koff.ro/img/a-1.webp", "https://cdn.koff.ro/img/a-2.webp"]);
  assert.equal(row.galleryFingerprint, computeGalleryFingerprint(row.galleryUrls));
  assert.equal(row.coverIdentity, "https://cdn.koff.ro/img/cover-a.webp");
  assert.equal(row.sourceId, "KF2365572");
  assert.equal(row.lastSuccessfulFetchAt, NOW);
  assert.equal(row.failureCount, 0);

  // The meta the planner needs in order to run incrementally at all.
  assert.equal(meta.bootstrapCompleted, true);
  assert.equal(meta.bootstrapRunId, RUN_ID);
  assert.equal(isGalleryMetaUsable(meta), true);
});

test("17b. a seeded catalog then performs ZERO detail fetches on the next run", async () => {
  // Realistically sized catalog: the mass guard trips above 2%, so a toy
  // fixture would abort rather than demonstrate the incremental reuse.
  const seeded = Array.from({ length: 1000 }, (_, i) => ({
    sourceProductId: 20_000 + i,
    imageUrl: `https://cdn.koff.ro/img/${i}.webp`,
    images: [`https://cdn.koff.ro/img/${i}-1.webp`, `https://cdn.koff.ro/img/${i}-2.webp`],
  }));
  const { rows, meta } = parseBootstrapArtifact(seeded, { now: NOW, runId: RUN_ID });
  assert.equal(rows.length, 1000);
  assert.equal(isGalleryMetaUsable(meta), true);

  // The next run's catalog is the seeded set plus ONE genuinely new product.
  const newcomer = { sourceProductId: 777_777, imageUrl: "https://cdn.koff.ro/img/new.webp" };
  const catalog = [...seeded.map((p) => ({ sourceProductId: p.sourceProductId, imageUrl: p.imageUrl })), newcomer];

  const plan = planGalleryRefresh({ catalog, stateRows: rows, meta });
  assert.equal(plan.abort, false);
  assert.deepEqual(plan.candidates, [{ sourceProductId: 777_777, reason: "no-state-row" }]);

  const calls = [];
  const store = createMemoryGalleryStateStore({ meta, rows });
  await runIncrementalGalleryPass({
    store,
    catalog,
    now: NOW + 1000,
    fetchGalleries: async (ids) => {
      calls.push([...ids]);
      return { galleries: new Map(ids.map((id) => [id, { ok: true, images: ["https://cdn.koff.ro/img/x.webp"] }])) };
    },
  });

  assert.deepEqual(calls, [[777_777]], "only the product with no seeded state was fetched");
  // The 1000 seeded galleries are still intact and untouched.
  const summary = summarizeGalleryState(store.peek().rows);
  assert.equal(summary.images, 2000 + 1);
});

test("17h. a corrupt state file aborts the run instead of fetching everything", async () => {
  const { coerceGalleryState } = await import("../gallery-state-store.mjs");
  // Truncated / garbage JSON reads as empty, and empty meta means "unusable",
  // so the planner aborts rather than treating it as "nothing is cached".
  assert.deepEqual(coerceGalleryState("{ not json"), { meta: null, rows: [] });
  assert.deepEqual(coerceGalleryState(""), { meta: null, rows: [] });

  const catalog = Array.from({ length: 1000 }, (_, i) => ({
    sourceProductId: 30_000 + i,
    imageUrl: `https://cdn.koff.ro/img/${i}.webp`,
  }));
  const plan = planGalleryRefresh({ catalog, stateRows: [], meta: coerceGalleryState("{ nope").meta });
  assert.equal(plan.abort, true);
  assert.deepEqual(plan.candidates, []);
});

test("17c. bootstrap statistics describe the imported state", () => {
  const { rows } = parseBootstrapArtifact(artifactFixture(), { now: NOW, runId: RUN_ID });
  const summary = summarizeGalleryState(rows);
  assert.equal(summary.products, 2);
  assert.equal(summary.images, 3);
  assert.equal(summary.byStatus[GALLERY_STATUS.READY], 2);
});

test("17d. an unrecognized artifact is rejected rather than half-imported", () => {
  for (const bad of [null, 42, "nope", { unexpected: true }]) {
    const { rows, stats, error } = parseBootstrapArtifact(bad, { now: NOW });
    assert.deepEqual(rows, []);
    assert.equal(stats.parsed, 0);
    assert.ok(error, "the shape problem is reported");
  }
});

test("17e. malformed rows are skipped without poisoning the import", () => {
  const { rows, stats } = parseBootstrapArtifact(
    [
      { sourceProductId: 1, images: ["https://cdn.koff.ro/img/1.webp"] },
      { sourceProductId: "not-a-number", images: ["https://cdn.koff.ro/img/x.webp"] },
      { sourceProductId: 0, images: ["https://cdn.koff.ro/img/y.webp"] },
      { sourceProductId: 2, images: ["https://cdn.koff.ro/img/1.webp", "https://cdn.koff.ro/img/1.webp"] },
      { sourceProductId: 3 },
      null,
    ],
    { now: NOW }
  );

  assert.deepEqual(rows.map((r) => r.sourceProductId), [1, 2]);
  // The duplicate image inside row 2 is collapsed.
  assert.deepEqual(rows.find((r) => r.sourceProductId === 2).galleryUrls, ["https://cdn.koff.ro/img/1.webp"]);
  assert.equal(stats.unusable, 1, "row 3 had no images");
});

test("17f. an array-shaped artifact (the raw scrape output) imports too", () => {
  const { rows } = parseBootstrapArtifact(artifactFixture().products, { now: NOW, runId: RUN_ID });
  assert.equal(rows.length, 2);
});

test("17g. a galleries-map artifact imports too", () => {
  const { rows } = parseBootstrapArtifact(
    {
      galleries: {
        371338: { coverIdentity: "https://cdn.koff.ro/img/cover-a.webp", images: ["https://cdn.koff.ro/img/a-1.webp"] },
      },
    },
    { now: NOW }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceProductId, 371338);
});

// --------------------------------------------------------------------------
// 18. Duplicate rows resolve deterministically
// --------------------------------------------------------------------------

test("18. duplicate sourceProductId bootstrap rows are handled deterministically", () => {
  const artifact = [
    { sourceProductId: 371338, imageUrl: "https://cdn.koff.ro/img/c1.webp", images: ["https://cdn.koff.ro/img/old-1.webp"] },
    { sourceProductId: 371338, imageUrl: "https://cdn.koff.ro/img/c2.webp", images: ["https://cdn.koff.ro/img/new-1.webp", "https://cdn.koff.ro/img/new-2.webp"] },
  ];

  const first = parseBootstrapArtifact(artifact, { now: NOW });
  const second = parseBootstrapArtifact(artifact, { now: NOW });

  // One row for the raw product, not two.
  assert.equal(first.rows.length, 1);
  assert.equal(first.stats.duplicates, 1);
  // The LAST occurrence wins - the later observation of that product.
  assert.deepEqual(first.rows[0].galleryUrls, [
    "https://cdn.koff.ro/img/new-1.webp",
    "https://cdn.koff.ro/img/new-2.webp",
  ]);
  // Deterministic: same input, same output.
  assert.deepEqual(first.rows, second.rows);
});

test("18b. duplicate handling holds regardless of which row is richer", () => {
  // Even when the FIRST row has more images, the last one is authoritative -
  // the rule is positional, so it never depends on comparing payloads.
  const artifact = [
    { sourceProductId: 5, images: ["https://cdn.koff.ro/img/a.webp", "https://cdn.koff.ro/img/b.webp"] },
    { sourceProductId: 5, images: ["https://cdn.koff.ro/img/c.webp"] },
  ];
  const { rows, stats } = parseBootstrapArtifact(artifact, { now: NOW });
  assert.equal(stats.duplicates, 1);
  assert.deepEqual(rows[0].galleryUrls, ["https://cdn.koff.ro/img/c.webp"]);
});

test("18c. a three-way duplicate still yields exactly one row", () => {
  const artifact = [1, 2, 3].map((n) => ({
    sourceProductId: 7,
    images: [`https://cdn.koff.ro/img/${n}.webp`],
  }));
  const { rows, stats } = parseBootstrapArtifact(artifact, { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(stats.duplicates, 2);
  assert.deepEqual(rows[0].galleryUrls, ["https://cdn.koff.ro/img/3.webp"]);
});
