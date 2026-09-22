import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  STAGING_DEPLOYMENT_ID,
  FORBIDDEN_DEPLOYMENT_IDS,
  StagingTargetError,
  classifyTarget,
  classifyRow,
  buildManifest,
  tally,
  parseMode,
  preflight,
  resolveAll,
  PreflightError,
  DISPOSITION,
} from "../staging-sync.mjs";

// All OFFLINE. Nothing here contacts a deployment.

// ==========================================================================
// 11-13. The target guard — staging-only, structurally
// ==========================================================================

test("13. staging mode accepts ONLY aware-toucan-771", () => {
  const r = classifyTarget(`https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.cloud`);
  assert.equal(r.ok, true);
  assert.equal(r.deploymentId, STAGING_DEPLOYMENT_ID);
  assert.equal(r.kind, "cloud");
  // The HTTP-actions host of the same deployment is the same target.
  assert.equal(classifyTarget(`https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.site`).ok, true);
});

test("11. staging mode rejects elated-butterfly-122 (production)", () => {
  assert.throws(
    () => classifyTarget("https://elated-butterfly-122.eu-west-1.convex.cloud"),
    (e) => e instanceof StagingTargetError && /elated-butterfly-122/.test(e.message)
      && /REFUSED/.test(e.message)
  );
});

test("12. staging mode rejects trustworthy-possum-230", () => {
  assert.throws(
    () => classifyTarget("https://trustworthy-possum-230.eu-west-1.convex.cloud"),
    (e) => e instanceof StagingTargetError && /trustworthy-possum-230/.test(e.message)
  );
});

test("12b. any other deployment is rejected too - there is no allow-list gap", () => {
  for (const url of [
    "https://some-other-deployment.eu-west-1.convex.cloud",
    "https://aware-toucan-772.eu-west-1.convex.cloud",
    "https://aware-toucan-77.eu-west-1.convex.cloud",
    "https://evil.example.com",
  ]) {
    assert.throws(() => classifyTarget(url), StagingTargetError, `should refuse ${url}`);
  }
});

test("12c. non-https and malformed targets are refused", () => {
  for (const url of ["http://aware-toucan-771.eu-west-1.convex.cloud", "", "not a url", null, undefined]) {
    assert.throws(() => classifyTarget(url), StagingTargetError, `should refuse ${String(url)}`);
  }
});

test("12d. the forbidden list is explicit and contains both protected deployments", () => {
  assert.deepEqual([...FORBIDDEN_DEPLOYMENT_IDS], ["elated-butterfly-122", "trustworthy-possum-230"]);
});

test("12e. the guard resolves the HOSTNAME, so a spoofed path cannot redirect it", () => {
  // The staging id appearing in a query string or path must not satisfy the guard.
  assert.throws(
    () => classifyTarget(`https://elated-butterfly-122.eu-west-1.convex.cloud/${STAGING_DEPLOYMENT_ID}`),
    StagingTargetError
  );
});

// ==========================================================================
// Classification — there is no CREATE outcome
// ==========================================================================

const resolved = (over = {}) => ({
  status: "EXACT_MATCH",
  productId: "p1",
  resolvedBy: "sourceKey",
  matchKey: "a|b|c|d",
  currentSourceKey: "sk",
  currentSourceProductId: 1,
  currentImage: "https://cdn.koff.ro/img/a.jpg",
  currentImagesCount: 1,
  currentPriceB2C: 24.34,
  currentPriceB2B: 21.52,
  ...over,
});

test("an EXACT_MATCH with a real difference is SAFE_UPDATE_EXISTING", () => {
  const d = classifyRow(resolved(), { images: ["a", "b", "c"], priceB2C: 25.99 });
  assert.equal(d, DISPOSITION.SAFE_UPDATE_EXISTING);
});

test("an EXACT_MATCH with nothing to change is NO_CHANGE", () => {
  const d = classifyRow(resolved(), { images: ["x"], priceB2C: 24.34, priceB2B: 21.52 });
  assert.equal(d, DISPOSITION.NO_CHANGE);
});

test("ambivalent/conflicting/missing resolutions never become an update", () => {
  assert.equal(classifyRow(resolved({ status: "AMBIGUOUS", productId: null }), { priceB2C: 1.99 }), DISPOSITION.AMBIGUOUS);
  assert.equal(classifyRow(resolved({ status: "CONFLICT", productId: null }), { priceB2C: 1.99 }), DISPOSITION.CONFLICT);
  assert.equal(classifyRow(resolved({ status: "NOT_FOUND", productId: null }), { priceB2C: 1.99 }), DISPOSITION.NOT_FOUND);
  assert.equal(classifyRow(null, { priceB2C: 1.99 }), DISPOSITION.NOT_FOUND);
});

test("the disposition set contains no CREATE value at all", () => {
  const values = Object.values(DISPOSITION);
  // Default sort order: "NOT_FOUND" precedes "NO_CHANGE" because "T" (0x54)
  // sorts before "_" (0x5F).
  assert.deepEqual(values.sort(), [
    "AMBIGUOUS", "CONFLICT", "NOT_FOUND", "NO_CHANGE", "SAFE_UPDATE_EXISTING",
  ]);
  for (const v of values) assert.doesNotMatch(v, /CREATE|INSERT|NEW_ROW/i);
});

// ==========================================================================
// Manifest — deterministic, checksummed
// ==========================================================================

const entry = (id, over = {}) => ({
  resolution: resolved({ productId: id, ...(over.resolution || {}) }),
  proposed: over.proposed || { images: ["a", "b"], priceB2C: 25.99 },
});

test("the manifest is byte-identical across runs (deterministic regeneration)", () => {
  const entries = [entry("p3"), entry("p1"), entry("p2")];
  const a = buildManifest(entries);
  const b = buildManifest([...entries].reverse()); // order-independent
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.canonical, b.canonical);
});

test("the manifest changes when the content changes", () => {
  const a = buildManifest([entry("p1")]);
  const b = buildManifest([entry("p1", { proposed: { images: ["a"], priceB2C: 25.99 } })]);
  assert.notEqual(a.sha256, b.sha256);
});

test("the manifest carries every required review field", () => {
  const m = buildManifest([entry("p1")]);
  const row = m.payload.rows[0];
  for (const k of [
    "productId", "sourceKey", "sourceProductId", "resolvedBy", "matchKey",
    "currentImage", "proposedImage", "currentImagesCount", "proposedImagesCount",
    "currentPriceB2C", "proposedPriceB2C", "currentPriceB2B", "proposedPriceB2B",
    "imagesChanged", "priceB2CChanged", "priceB2BChanged",
  ]) {
    assert.ok(k in row, `manifest row is missing ${k}`);
  }
  assert.equal(m.payload.target, STAGING_DEPLOYMENT_ID);
});

test("tally counts change kinds for SAFE_UPDATE_EXISTING rows", () => {
  const entries = [
    entry("p1", { proposed: { images: ["a", "b"], priceB2C: 24.34, priceB2B: 21.52 } }), // images only
    entry("p2", { proposed: { images: ["x"], priceB2C: 25.99, priceB2B: 21.52 } }),      // price only
    entry("p3", { proposed: { images: ["a", "b"], priceB2C: 25.99, priceB2B: 21.52 } }), // both
  ];
  const t = tally(entries.map((e) => classifyRow(e.resolution, e.proposed)), entries);
  assert.equal(t.IMAGES_CHANGE, 2);
  assert.equal(t.PRICE_B2C_CHANGE, 2);
  assert.equal(t.PRICE_B2B_CHANGE, 0);
  assert.equal(t.BOTH_IMAGE_AND_PRICE_CHANGE, 1);
});

// ==========================================================================
// 14. Dry run performs zero mutations
// ==========================================================================

test("14. the default mode is dry-run", () => {
  const m = parseMode(["node", "staging-sync.mjs"]);
  assert.equal(m.dryRun, true);
  assert.equal(m.apply, false);
});

test("14b. --apply is refused without an explicit reviewed checksum", () => {
  assert.throws(() => parseMode(["node", "staging-sync.mjs", "--apply"]), /expect-sha256/);
});

test("14c. --apply carries the checksum through when supplied", () => {
  const m = parseMode(["node", "staging-sync.mjs", "--apply", "--expect-sha256", "abc123"]);
  assert.equal(m.apply, true);
  assert.equal(m.expectSha256, "abc123");
  assert.equal(m.dryRun, false);
});

test("14d. the tool source contains no create/insert call and no bare env-var trust", () => {
  const src = readFileSync(new URL("../staging-sync.mjs", import.meta.url), "utf8");
  // No write path of its own beyond the update-only mutation. Match an actual
  // CALL, not the word - the prose explaining the absence of an insert path
  // legitimately contains it.
  assert.doesNotMatch(src, /\.insert\s*\(/);
  // The target decision must come from classifyTarget, not process.env alone.
  assert.match(src, /classifyTarget/);
  assert.doesNotMatch(src, /process\.env\.CONVEX_URL\s*\|\|\s*STAGING/);
  // And it must never reference the production id as a usable target.
  assert.doesNotMatch(src, /OWNED_CASEKING_CONVEX_URL/);
});

// ==========================================================================
// Preflight gates — order matters: target is checked BEFORE credentials
// ==========================================================================

test("preflight refuses a non-staging target even when a credential is present", () => {
  assert.throws(
    () => preflight({ convexUrl: "https://elated-butterfly-122.eu-west-1.convex.cloud", syncSecret: "x".repeat(40) }),
    (e) => e instanceof StagingTargetError
  );
});

test("preflight reports the missing credential precisely, without weakening the resolver", () => {
  assert.throws(
    () => preflight({ convexUrl: `https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.cloud` }),
    (e) => e instanceof PreflightError && e.code === "MISSING_SYNC_CREDENTIAL"
      && /not available locally/.test(e.message)
  );
});

test("preflight rejects a too-short credential", () => {
  assert.throws(
    () => preflight({ convexUrl: `https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.cloud`, syncSecret: "short" }),
    (e) => e instanceof PreflightError && e.code === "INVALID_SYNC_CREDENTIAL"
  );
});

test("preflight passes for the staging target with an adequate credential", () => {
  const r = preflight({
    convexUrl: `https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.cloud`,
    syncSecret: "x".repeat(40),
  });
  assert.equal(r.ok, true);
  assert.equal(r.deploymentId, STAGING_DEPLOYMENT_ID);
});

test("resolveAll issues QUERIES only - it can never mutate", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ status: "success", value: [{ status: "NOT_FOUND", productId: null, matchKey: "a|b|c|d", resolvedBy: null, candidateCount: 0, currentProductId: null, currentSourceKey: null, currentSourceProductId: null, currentImage: null, currentImagesCount: 0, currentPriceB2C: null, currentPriceB2B: null }] }),
    };
  };
  await resolveAll(
    [{ name: "x", brand: "y", model: "z", category: "c" }],
    { baseUrl: `https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.cloud`, syncSecret: "x".repeat(40), fetchImpl }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.path, "koffStagingSync:resolveExistingProducts");
  // A query endpoint, and never the mutation endpoint.
  assert.match(calls[0].url, /\/api\/query$/);
  assert.doesNotMatch(calls[0].url, /\/api\/mutation/);
});

test("resolveAll batches without changing the payload contents", async () => {
  const batches = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    batches.push(body.args.rows.length);
    return {
      ok: true,
      json: async () => ({ status: "success", value: body.args.rows.map(() => ({ status: "NOT_FOUND", productId: null, matchKey: "k", resolvedBy: null, candidateCount: 0, currentProductId: null, currentSourceKey: null, currentSourceProductId: null, currentImage: null, currentImagesCount: 0, currentPriceB2C: null, currentPriceB2B: null })) }),
    };
  };
  const rows = Array.from({ length: 250 }, (_, i) => ({ name: `n${i}`, brand: "b", model: "m", category: "c" }));
  const out = await resolveAll(rows, {
    baseUrl: `https://${STAGING_DEPLOYMENT_ID}.eu-west-1.convex.cloud`,
    syncSecret: "x".repeat(40),
    fetchImpl,
    batchSize: 100,
  });
  assert.deepEqual(batches, [100, 100, 50]);
  assert.equal(out.length, 250);
});
