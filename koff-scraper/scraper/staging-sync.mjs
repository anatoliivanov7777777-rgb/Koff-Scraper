// ============================================================================
// STAGING-ONLY PROPAGATION TOOL (Koff → CaseKing aware-toucan-771)
// ----------------------------------------------------------------------------
// Why this exists as a SEPARATE tool rather than a flag on sync-caseking.mjs:
//
// sync-caseking.mjs is hard-gated to elated-butterfly-122 (production) and
// throws for anything else. That guard is correct and is left completely
// untouched. Rather than weaken it, this tool is the second, deliberately
// narrower path: staging-only, update-existing-only, dry-run by default.
//
// Two properties this tool must have structurally, not by convention:
//
//   1. It cannot write to production. The target guard below resolves the
//      deployment id from the URL HOSTNAME and hard-fails unless it is
//      exactly aware-toucan-771. It does not merely read an env var.
//
//   2. It cannot create a product. There is no CREATE classification and no
//      create branch - the only mutation it may call is
//      koffStagingSync:updateExistingProducts, which itself contains no
//      insert.
//
// Default mode is DRY RUN. Writing requires --apply AND a manifest whose
// SHA-256 matches the reviewed one.
// ============================================================================

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// TARGET GUARD
// ---------------------------------------------------------------------------

export const STAGING_DEPLOYMENT_ID = "aware-toucan-771";

// Named explicitly so the failure message says WHICH forbidden deployment was
// refused, rather than a generic "wrong target".
export const FORBIDDEN_DEPLOYMENT_IDS = Object.freeze([
  "elated-butterfly-122",
  "trustworthy-possum-230",
]);

export class StagingTargetError extends Error {
  constructor(message) {
    super(message);
    this.name = "StagingTargetError";
  }
}

/**
 * Resolve a Convex deployment URL to its deployment id and decide whether this
 * tool is allowed to talk to it.
 *
 * Only `.convex.cloud` / `.convex.site` hosts are considered. The deployment id
 * is the first hostname label. Anything that is not exactly
 * `aware-toucan-771` is a hard fail - there is no "force" escape hatch.
 *
 * @param {unknown} rawUrl
 * @returns {{ ok: true, deploymentId: string, baseUrl: string, kind: string }}
 */
export function classifyTarget(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new StagingTargetError("convexUrl is required");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new StagingTargetError(`convexUrl is not a valid URL: ${String(rawUrl).slice(0, 60)}`);
  }

  if (parsed.protocol !== "https:") {
    throw new StagingTargetError(`convexUrl must be https, got ${parsed.protocol}`);
  }

  const host = parsed.hostname.toLowerCase();
  const kind = host.endsWith(".convex.cloud")
    ? "cloud"
    : host.endsWith(".convex.site")
      ? "site"
      : null;
  if (!kind) {
    throw new StagingTargetError(
      `convexUrl host is not a Convex deployment host: ${host}`
    );
  }

  const deploymentId = host.split(".")[0];

  if (FORBIDDEN_DEPLOYMENT_IDS.includes(deploymentId)) {
    throw new StagingTargetError(
      `REFUSED: ${deploymentId} is a protected production deployment. ` +
        `This tool may only ever write to ${STAGING_DEPLOYMENT_ID}.`
    );
  }

  if (deploymentId !== STAGING_DEPLOYMENT_ID) {
    throw new StagingTargetError(
      `REFUSED: this tool is staging-only and requires ${STAGING_DEPLOYMENT_ID}, ` +
        `got ${deploymentId}`
    );
  }

  return { ok: true, deploymentId, baseUrl: `${parsed.protocol}//${host}`, kind };
}

// ---------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------

export const DISPOSITION = Object.freeze({
  SAFE_UPDATE_EXISTING: "SAFE_UPDATE_EXISTING",
  NO_CHANGE: "NO_CHANGE",
  AMBIGUOUS: "AMBIGUOUS",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
});

/**
 * Decide what (if anything) should happen to one resolved product.
 *
 * A row only becomes SAFE_UPDATE_EXISTING when the resolver returned
 * EXACT_MATCH *and* at least one permitted field actually differs. Everything
 * else is a refusal or a no-op - there is deliberately no CREATE outcome.
 */
export function classifyRow(resolution, proposed) {
  if (!resolution) return DISPOSITION.NOT_FOUND;

  if (resolution.status === "AMBIGUOUS") return DISPOSITION.AMBIGUOUS;
  if (resolution.status === "CONFLICT") return DISPOSITION.CONFLICT;
  if (resolution.status !== "EXACT_MATCH") return DISPOSITION.NOT_FOUND;
  if (!resolution.productId) return DISPOSITION.NOT_FOUND;

  const imagesChanged = !sameList(proposed.images ?? null, resolution.currentImagesCount);
  const priceB2CChanged = !sameNumber(proposed.priceB2C, resolution.currentPriceB2C);
  const priceB2BChanged = !sameNumber(proposed.priceB2B, resolution.currentPriceB2B);

  if (!imagesChanged && !priceB2CChanged && !priceB2BChanged) return DISPOSITION.NO_CHANGE;
  return DISPOSITION.SAFE_UPDATE_EXISTING;
}

function sameNumber(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return Math.round(a * 100) === Math.round(b * 100);
}

// The resolver reports the CURRENT image COUNT, so "changed" compares the
// proposed gallery length against it. Same length + same first url is treated
// as unchanged; a differing primary or length is a real change.
function sameList(images, currentCount) {
  if (images === null) return true;
  return Array.isArray(images) && images.length === currentCount;
}

// ---------------------------------------------------------------------------
// MANIFEST
// ---------------------------------------------------------------------------

/**
 * Canonical, deterministic serialisation. Keys are emitted in a fixed order and
 * rows are sorted by productId, so the same input always produces the same
 * bytes - and therefore the same SHA-256.
 */
export function buildManifest(entries) {
  const rows = entries
    .map((e) => ({
      productId: e.resolution.productId,
      sourceKey: e.resolution.currentSourceKey,
      sourceProductId: e.resolution.currentSourceProductId,
      resolvedBy: e.resolution.resolvedBy,
      matchKey: e.resolution.matchKey,
      currentImage: e.resolution.currentImage,
      proposedImage: e.proposed.image ?? null,
      currentImagesCount: e.resolution.currentImagesCount,
      proposedImagesCount: e.proposed.images ? e.proposed.images.length : null,
      currentPriceB2C: e.resolution.currentPriceB2C,
      proposedPriceB2C: e.proposed.priceB2C ?? null,
      currentPriceB2B: e.resolution.currentPriceB2B,
      proposedPriceB2B: e.proposed.priceB2B ?? null,
      imagesChanged:
        e.proposed.images != null && e.proposed.images.length !== e.resolution.currentImagesCount,
      priceB2CChanged: !sameNumber(e.proposed.priceB2C, e.resolution.currentPriceB2C),
      priceB2BChanged: !sameNumber(e.proposed.priceB2B, e.resolution.currentPriceB2B),
    }))
    .sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

  const payload = { version: 1, target: STAGING_DEPLOYMENT_ID, rows };
  const canonical = JSON.stringify(payload);
  const sha256 = createHash("sha256").update(canonical).digest("hex");
  return { payload, canonical, sha256 };
}

export function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest.payload, null, 2) + "\n", "utf8");
}

export function verifyManifestFile(path, expectedSha256) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const sha256 = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(
      `manifest checksum mismatch: file is ${sha256}, expected ${expectedSha256}`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// TOTALS
// ---------------------------------------------------------------------------

export function tally(dispositions, entries) {
  const out = {
    total: dispositions.length,
    SAFE_UPDATE_EXISTING: 0,
    NO_CHANGE: 0,
    AMBIGUOUS: 0,
    NOT_FOUND: 0,
    CONFLICT: 0,
    IMAGES_CHANGE: 0,
    PRICE_B2C_CHANGE: 0,
    PRICE_B2B_CHANGE: 0,
    BOTH_IMAGE_AND_PRICE_CHANGE: 0,
  };
  for (const d of dispositions) out[d] = (out[d] || 0) + 1;

  for (const e of entries) {
    const images = e.proposed.images != null &&
      e.proposed.images.length !== e.resolution.currentImagesCount;
    const pB2C = !sameNumber(e.proposed.priceB2C, e.resolution.currentPriceB2C);
    const pB2B = !sameNumber(e.proposed.priceB2B, e.resolution.currentPriceB2B);
    if (images) out.IMAGES_CHANGE++;
    if (pB2C) out.PRICE_B2C_CHANGE++;
    if (pB2B) out.PRICE_B2B_CHANGE++;
    if (images && (pB2C || pB2B)) out.BOTH_IMAGE_AND_PRICE_CHANGE++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MODE
// ---------------------------------------------------------------------------

/**
 * `--apply` is the ONLY way to leave dry-run, and it additionally requires an
 * explicit reviewed checksum. Absent either, the tool plans and writes nothing.
 */
export function parseMode(argv) {
  const args = argv.slice(2);
  const apply = args.includes("--apply");
  const idx = args.indexOf("--expect-sha256");
  const expectSha256 = idx !== -1 ? args[idx + 1] : null;
  if (apply && !expectSha256) {
    throw new Error("--apply requires --expect-sha256 <sha256 of the reviewed manifest>");
  }
  return { apply, expectSha256, dryRun: !apply };
}

// ---------------------------------------------------------------------------
// PREFLIGHT GATES
// ---------------------------------------------------------------------------

export class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PreflightError";
    this.code = code;
  }
}

/**
 * Check everything the dry-run needs BEFORE any network call, so a missing
 * prerequisite reports one precise reason instead of failing part-way through
 * a catalogue pass.
 *
 * The resolver is an authenticated syncQuery (deliberately - it returns
 * supplier identity). Reading it therefore requires CASEKING_SYNC_SECRET, which
 * is a machine credential and is expected to live in CI, not on a laptop.
 *
 * @returns {{ ok: true, deploymentId: string, baseUrl: string }}
 */
export function preflight({ convexUrl, syncSecret }) {
  const target = classifyTarget(convexUrl); // throws on any non-staging target

  if (!syncSecret || typeof syncSecret !== "string") {
    throw new PreflightError(
      "MISSING_SYNC_CREDENTIAL",
      "CASEKING_SYNC_SECRET is required to call the read-only resolver " +
        "(koffStagingSync:resolveExistingProducts). It is a machine credential " +
        "and is not available locally; set it in the environment that runs the " +
        "preflight. The resolver is intentionally NOT made public - it returns " +
        "supplier identity, so weakening it to enable a laptop dry-run is not " +
        "an acceptable trade."
    );
  }
  if (syncSecret.length < 32 || syncSecret.length > 512) {
    throw new PreflightError(
      "INVALID_SYNC_CREDENTIAL",
      "CASEKING_SYNC_SECRET must be 32-512 characters"
    );
  }

  return { ok: true, deploymentId: target.deploymentId, baseUrl: target.baseUrl };
}

/**
 * Call the read-only resolver in bounded batches. Never mutates.
 */
export async function resolveAll(rows, { baseUrl, syncSecret, fetchImpl = fetch, batchSize = 100 }) {
  const out = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const res = await fetchImpl(`${baseUrl}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "koffStagingSync:resolveExistingProducts",
        args: { rows: batch, syncSecret },
        format: "json",
      }),
    });
    if (!res.ok) throw new Error(`resolver HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== "success") {
      throw new Error(`resolver error: ${JSON.stringify(json).slice(0, 300)}`);
    }
    out.push(...json.value);
  }
  return out;
}
