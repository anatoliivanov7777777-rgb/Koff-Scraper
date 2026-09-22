// Incremental gallery state.
//
// WHY THIS EXISTS
// The gallery pass re-requested /api/product/:id for the ENTIRE raw catalog
// every time it ran - ~28k detail requests to discover galleries that, for the
// overwhelming majority of products, had not changed at all. This module
// decides which raw Koff products actually need a detail request, so a normal
// run asks about the few that changed instead of all of them.
//
// WHAT IT CANNOT DO (stated plainly, not hidden)
// There is NO verified complete Koff gallery-revision signal in the catalog
// feed. The feed carries a cover image, not a gallery version. So a change to
// a SECONDARY gallery image, with the cover untouched, is NOT detectable from
// the feed alone. This design deliberately trades instant detection of that
// one case for a drastic reduction in Koff load. A controlled full refresh
// (FULL_GALLERY_REFRESH=true) is the escape hatch for it.
//
// KEY
// State is keyed by the RAW Koff product id (sourceProductId). One raw product
// may expand into several CaseKing storefront rows; gallery state belongs to
// the raw product, never to a generated variant, slug or product name.
//
// Everything here is pure: no network, no filesystem, no clock of its own.
// Callers inject `now`. This is what lets the whole policy be tested offline.

import { createHash } from "node:crypto";

/** Bumped whenever the stored row shape changes incompatibly. */
export const GALLERY_STATE_SCHEMA_VERSION = 1;

/** Max detail requests a normal incremental run may make. */
export const MAX_CANDIDATES = 500;

/** Max share of the catalog a normal run may spend detail requests on. */
export const MAX_CANDIDATE_PERCENT = 2;

export const GALLERY_STATUS = Object.freeze({
  READY: "ready",
  FAILED: "failed",
  MISSING: "missing",
});

/**
 * Cover identity used for change detection.
 *
 * Koff serves images from a CDN and appends cache-busting query strings on
 * some paths, so the query and fragment are stripped before comparing -
 * otherwise every run would look like "the cover changed" and defeat the whole
 * point of the guard. Returns null for anything that is not a usable URL.
 */
export function normalizeCoverIdentity(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not absolute - keep the path-ish value minus its query, lowercased host
    // is not applicable, so just strip query/fragment textually.
    return trimmed.split("#")[0].split("?")[0];
  }
}

/** Dedupe + trim a gallery URL list, preserving supplier order (cover first). */
export function normalizeGalleryUrls(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const urls = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    urls.push(trimmed);
  }
  return urls;
}

/**
 * Deterministic fingerprint of a gallery. Order matters: the cover leads the
 * list, so a reordered gallery is a real change and must be recorded.
 */
export function computeGalleryFingerprint(urls) {
  const normalized = normalizeGalleryUrls(urls);
  return createHash("sha256").update(normalized.join("\n")).digest("hex");
}

/** A fresh, empty global meta record. */
export function createGalleryMeta(overrides = {}) {
  return {
    schemaVersion: GALLERY_STATE_SCHEMA_VERSION,
    bootstrapCompleted: false,
    bootstrapRunId: null,
    bootstrapCompletedAt: null,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * True when the global state is usable for incremental operation.
 *
 * Missing or corrupt global state must ABORT a normal run, never be read as
 * "no state means fetch everything" - that failure mode is precisely what the
 * mass-request guard exists to prevent, and it is the one an uninitialised
 * backend would produce.
 */
export function isGalleryMetaUsable(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.schemaVersion !== GALLERY_STATE_SCHEMA_VERSION) return false;
  return meta.bootstrapCompleted === true;
}

/** Rationale for a rejected meta record, for the operator-facing report. */
export function describeGalleryMetaProblem(meta) {
  if (!meta || typeof meta !== "object") return "global gallery state is missing";
  if (meta.schemaVersion !== GALLERY_STATE_SCHEMA_VERSION) {
    return `global gallery state schema version ${meta.schemaVersion} is not ${GALLERY_STATE_SCHEMA_VERSION}`;
  }
  if (meta.bootstrapCompleted !== true) return "global gallery state was never bootstrapped";
  return "global gallery state is unusable";
}

/** Coerce a stored row into the canonical shape, dropping anything unknown. */
export function normalizeGalleryStateRow(raw, sourceProductId) {
  if (!raw || typeof raw !== "object") return null;
  const id = Number.isInteger(sourceProductId) ? sourceProductId : raw.sourceProductId;
  if (!Number.isInteger(id) || id <= 0) return null;
  const urls = normalizeGalleryUrls(raw.galleryUrls);
  return {
    sourceProductId: id,
    sourceId: typeof raw.sourceId === "string" && raw.sourceId.trim() ? raw.sourceId : null,
    coverIdentity: normalizeCoverIdentity(raw.coverIdentity),
    galleryUrls: urls,
    galleryFingerprint: typeof raw.galleryFingerprint === "string" && raw.galleryFingerprint
      ? raw.galleryFingerprint
      : (urls.length ? computeGalleryFingerprint(urls) : null),
    lastSuccessfulFetchAt: Number.isFinite(raw.lastSuccessfulFetchAt) ? raw.lastSuccessfulFetchAt : null,
    lastAttemptAt: Number.isFinite(raw.lastAttemptAt) ? raw.lastAttemptAt : null,
    lastFailureAt: Number.isFinite(raw.lastFailureAt) ? raw.lastFailureAt : null,
    failureCount: Number.isInteger(raw.failureCount) && raw.failureCount > 0 ? raw.failureCount : 0,
    status: Object.values(GALLERY_STATUS).includes(raw.status) ? raw.status : GALLERY_STATUS.MISSING,
  };
}

/**
 * True when a stored row carries a usable gallery payload.
 *
 * A row can exist and still be unusable: a previous run may have written the
 * product id and then failed, or an older/importer-written row may lack the
 * fingerprint. Those are "individually missing / incomplete" and become
 * candidates again rather than being trusted as a cache hit.
 */
export function isGalleryStateRowComplete(row) {
  if (!row) return false;
  if (row.status !== GALLERY_STATUS.READY) return false;
  if (!row.galleryFingerprint) return false;
  if (!Array.isArray(row.galleryUrls)) return false;
  return row.lastSuccessfulFetchAt !== null;
}

/** Eligibility of a previously failed product for another attempt. */
export function isRetryEligible(row) {
  return Boolean(row) && row.status === GALLERY_STATUS.FAILED;
}

/**
 * Why this product is (or is not) a gallery-detail candidate.
 * Returns null when the product can be served entirely from cache.
 */
export function galleryCandidateReason({ sourceProductId, coverIdentity }, row) {
  if (!row) return "no-state-row";
  // Checked BEFORE completeness: a failed row is deliberately incomplete (its
  // status is not "ready"), so testing completeness first would classify every
  // retry as generic "state-incomplete" and lose the distinction.
  if (isRetryEligible(row)) return "failed-retry";
  if (!isGalleryStateRowComplete(row)) return "state-incomplete";
  const currentCover = normalizeCoverIdentity(coverIdentity);
  if (currentCover !== row.coverIdentity) return "cover-changed";
  return null;
}

/**
 * Decide what a gallery run should do.
 *
 * NORMAL mode applies the incremental rule and the mass-request guard.
 * FULL mode (FULL_GALLERY_REFRESH=true, explicit and off by default) makes
 * every catalog product a candidate and bypasses the guard, because that is
 * the one case where a large candidate count is the intent rather than a
 * symptom of broken state.
 *
 * On abort, `candidates` is empty - so a caller that simply fetches the
 * returned candidate list makes zero detail requests without needing its own
 * guard.
 */
export function planGalleryRefresh({
  catalog,
  stateRows,
  meta,
  fullRefresh = false,
  maxCandidates = MAX_CANDIDATES,
  maxCandidatePercent = MAX_CANDIDATE_PERCENT,
} = {}) {
  const products = Array.isArray(catalog) ? catalog : [];
  const catalogSize = products.length;
  const byId = stateRows instanceof Map ? stateRows : new Map(
    (Array.isArray(stateRows) ? stateRows : [])
      .map((row) => [row && row.sourceProductId, row])
      .filter(([id]) => Number.isInteger(id))
  );

  const base = {
    mode: fullRefresh ? "full" : "incremental",
    catalogSize,
    candidates: [],
    abort: false,
    reason: null,
    counts: {},
  };

  if (fullRefresh) {
    // Same one-per-raw-product rule as the incremental path.
    const candidates = [];
    const seen = new Set();
    for (const product of products) {
      const id = product?.sourceProductId;
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ sourceProductId: id, reason: "full-refresh" });
    }
    return { ...base, candidates, counts: { "full-refresh": candidates.length } };
  }

  // Normal mode refuses to guess. Without usable global state there is no way
  // to tell "nothing has a gallery yet" apart from "the state was lost", and
  // guessing wrong means ~28k detail requests.
  if (!isGalleryMetaUsable(meta)) {
    return { ...base, abort: true, reason: describeGalleryMetaProblem(meta) };
  }

  // One candidate per RAW Koff product, not per catalog row. A single raw
  // product routinely expands into several CaseKing storefront rows (one per
  // compatible device), all sharing a sourceProductId - without this dedupe
  // each variant would queue its own identical detail request.
  const candidates = [];
  const counts = {};
  const seen = new Set();
  for (const product of products) {
    if (!Number.isInteger(product?.sourceProductId) || product.sourceProductId <= 0) continue;
    if (seen.has(product.sourceProductId)) continue;
    seen.add(product.sourceProductId);
    const row = byId.get(product.sourceProductId) ?? null;
    const reason = galleryCandidateReason(
      { sourceProductId: product.sourceProductId, coverIdentity: product.coverIdentity ?? product.imageUrl ?? product.coverUrl },
      row
    );
    if (!reason) continue;
    counts[reason] = (counts[reason] ?? 0) + 1;
    candidates.push({ sourceProductId: product.sourceProductId, reason });
  }

  const percent = catalogSize === 0 ? 0 : (candidates.length / catalogSize) * 100;
  const overCount = candidates.length > maxCandidates;
  const overPercent = percent > maxCandidatePercent;

  if (catalogSize > 0 && (overCount || overPercent)) {
    return {
      ...base,
      candidates: [],
      abort: true,
      reason: overCount
        ? `candidate count ${candidates.length} exceeds the ${maxCandidates} limit`
        : `candidate count ${candidates.length} is ${percent.toFixed(2)}% of the catalog, over the ${maxCandidatePercent}% limit`,
      candidateCount: candidates.length,
      candidatePercent: percent,
      counts,
    };
  }

  return {
    ...base,
    candidates,
    candidateCount: candidates.length,
    candidatePercent: percent,
    counts,
  };
}

/**
 * Fold a run's fetch results back into the state rows.
 *
 * Two rules that matter:
 *  - A SUCCESS writes the new gallery and clears the failure counters.
 *  - A FAILURE records the failure but NEVER erases the last known good
 *    gallery. A transient 503 must not destroy a gallery that took a real
 *    fetch to establish; the row keeps its previous urls/fingerprint and only
 *    flips status to failed so the next run retries it.
 */
export function applyGalleryResults({ stateRows, catalog, results, now }) {
  const byId = stateRows instanceof Map ? new Map(stateRows) : new Map(
    (Array.isArray(stateRows) ? stateRows : [])
      .map((row) => [row && row.sourceProductId, normalizeGalleryStateRow(row)])
      .filter(([id]) => Number.isInteger(id))
  );

  const coverById = new Map();
  for (const product of Array.isArray(catalog) ? catalog : []) {
    if (Number.isInteger(product?.sourceProductId)) {
      coverById.set(
        product.sourceProductId,
        normalizeCoverIdentity(product.coverIdentity ?? product.imageUrl ?? product.coverUrl)
      );
    }
  }

  for (const [sourceProductId, result] of results instanceof Map ? results : new Map()) {
    const existing = byId.get(sourceProductId) ?? null;
    const coverIdentity = coverById.get(sourceProductId) ?? existing?.coverIdentity ?? null;

    if (result?.ok) {
      const galleryUrls = normalizeGalleryUrls(result.images);
      byId.set(sourceProductId, {
        sourceProductId,
        sourceId: existing?.sourceId ?? null,
        coverIdentity,
        galleryUrls,
        galleryFingerprint: computeGalleryFingerprint(galleryUrls),
        lastSuccessfulFetchAt: now,
        lastAttemptAt: now,
        lastFailureAt: existing?.lastFailureAt ?? null,
        failureCount: 0,
        status: GALLERY_STATUS.READY,
      });
      continue;
    }

    byId.set(sourceProductId, {
      sourceProductId,
      sourceId: existing?.sourceId ?? null,
      coverIdentity,
      // Preserved on purpose: see the doc comment above.
      galleryUrls: existing?.galleryUrls ?? [],
      galleryFingerprint: existing?.galleryFingerprint ?? null,
      lastSuccessfulFetchAt: existing?.lastSuccessfulFetchAt ?? null,
      lastAttemptAt: now,
      lastFailureAt: now,
      failureCount: (existing?.failureCount ?? 0) + 1,
      status: GALLERY_STATUS.FAILED,
    });
  }

  return byId;
}

/**
 * Parse a previously captured gallery artifact into durable state.
 *
 * This is the bootstrap path: the artifact already holds the full gallery for
 * the catalog, so importing it seeds the state WITHOUT re-requesting a single
 * product detail endpoint. Nothing here touches the network.
 *
 * Accepted shapes, in order of preference:
 *   - an array of product rows (the koff-products-raw.json scrape.mjs writes)
 *   - { products: [...] }
 *   - { galleries: { "<id>": { images: [...] } } }
 *
 * Duplicate sourceProductId rows are resolved deterministically: the LAST
 * occurrence wins, and the duplicate count is reported so an operator can see
 * it. A later row in a capture is the more recent observation of that product.
 */
export function parseBootstrapArtifact(artifact, { now = 0, runId = null } = {}) {
  const rows = [];
  const push = (sourceProductId, sourceId, coverIdentity, images) => {
    if (!Number.isInteger(sourceProductId) || sourceProductId <= 0) return;
    rows.push({ sourceProductId, sourceId, coverIdentity, images });
  };

  if (Array.isArray(artifact)) {
    for (const product of artifact) {
      if (!product || typeof product !== "object") continue;
      push(
        product.sourceProductId,
        product.sourceId ?? product.sku ?? null,
        product.coverIdentity ?? product.imageUrl ?? product.coverUrl ?? null,
        product.images ?? product.galleryUrls ?? null
      );
    }
  } else if (artifact && typeof artifact === "object" && Array.isArray(artifact.products)) {
    for (const product of artifact.products) {
      if (!product || typeof product !== "object") continue;
      push(
        product.sourceProductId,
        product.sourceId ?? product.sku ?? null,
        product.coverIdentity ?? product.imageUrl ?? product.coverUrl ?? null,
        product.images ?? product.galleryUrls ?? null
      );
    }
  } else if (artifact && typeof artifact === "object" && artifact.galleries && typeof artifact.galleries === "object") {
    for (const [key, value] of Object.entries(artifact.galleries)) {
      const id = Number(key);
      push(id, value?.sourceId ?? null, value?.coverIdentity ?? null, value?.images ?? value?.galleryUrls ?? null);
    }
  } else {
    return { rows: [], meta: createGalleryMeta(), stats: { parsed: 0, duplicates: 0, unusable: 0, totalImages: 0 }, error: "unrecognized artifact shape" };
  }

  const stateRows = new Map();
  let duplicates = 0;
  let unusable = 0;
  let totalImages = 0;

  for (const row of rows) {
    if (!Array.isArray(row.images) || row.images.length === 0) {
      unusable++;
      continue;
    }
    if (stateRows.has(row.sourceProductId)) duplicates++;
    const galleryUrls = normalizeGalleryUrls(row.images);
    totalImages += galleryUrls.length;
    stateRows.set(row.sourceProductId, {
      sourceProductId: row.sourceProductId,
      sourceId: row.sourceId ?? null,
      coverIdentity: normalizeCoverIdentity(row.coverIdentity),
      galleryUrls,
      galleryFingerprint: computeGalleryFingerprint(galleryUrls),
      lastSuccessfulFetchAt: now,
      lastAttemptAt: now,
      lastFailureAt: null,
      failureCount: 0,
      status: GALLERY_STATUS.READY,
    });
  }

  return {
    rows: [...stateRows.values()],
    meta: createGalleryMeta({
      bootstrapCompleted: true,
      bootstrapRunId: runId,
      bootstrapCompletedAt: now,
      updatedAt: now,
    }),
    stats: { parsed: rows.length, duplicates, unusable, totalImages },
  };
}

/** Count of distinct products and gallery images currently held in state. */
export function summarizeGalleryState(stateRows) {
  const rows = stateRows instanceof Map ? [...stateRows.values()] : (Array.isArray(stateRows) ? stateRows : []);
  let images = 0;
  const byStatus = {};
  for (const row of rows) {
    if (!row) continue;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    images += Array.isArray(row.galleryUrls) ? row.galleryUrls.length : 0;
  }
  return { products: rows.length, images, byStatus };
}
