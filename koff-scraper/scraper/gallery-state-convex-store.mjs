// Convex-backed gallery state.
//
// Persistence ONLY. The planner in gallery-state.mjs still decides what to
// fetch; this file just makes the state durable across runs by storing it in
// the dedicated Koff Convex deployment instead of a file that dies with the CI
// runner.
//
// AUTHENTICATED BOUNDARY
// The galleryState functions are INTERNAL on the Convex side - they are not
// callable as a public API. The only way in is the secret-checked HTTP routes
// in convex/http.ts, so this adapter speaks HTTP and sends
// `x-koff-gallery-state-secret` on every request.
//
// No deployment URL and no secret live in this file. Both are injected at
// runtime, which keeps the module deployment-agnostic and means the repository
// never carries a credential.

import { GALLERY_STATE_SCHEMA_VERSION } from "./gallery-state.mjs";
import { coerceGalleryState, emptyGalleryState } from "./gallery-state-store.mjs";

/** Rows per Convex mutation. A full import is 28k+ rows, so it must be batched. */
export const DEFAULT_BATCH_SIZE = 200;

/** Rows per page read. Matches the server-side ceiling in http.ts. */
export const DEFAULT_PAGE_SIZE = 500;

/** The header the Convex boundary requires. */
export const GALLERY_STATE_SECRET_HEADER = "x-koff-gallery-state-secret";

/** Environment variable holding the dedicated gallery-state secret. */
export const GALLERY_STATE_SECRET_ENV = "KOFF_GALLERY_STATE_SECRET";

/** Environment variable holding the deployment's HTTP actions URL. */
export const GALLERY_STATE_HTTP_URL_ENV = "KOFF_GALLERY_STATE_HTTP_URL";

/**
 * Validates the runtime configuration for the durable gallery store.
 *
 * Pure and side-effect free so it can be tested directly, and so the scraper
 * can call it BEFORE anything else happens. With gallery fetching on there is
 * no safe degraded mode - a missing secret must stop the run, not fall back to
 * a different store or to "no state, fetch everything".
 *
 * Returns { ok, errors } where errors are operator-facing strings naming the
 * offending variable. Never includes a value.
 */
export function validateGalleryStateConfig({ httpActionsUrl, secret } = {}) {
  const errors = [];

  if (!httpActionsUrl) {
    errors.push(`${GALLERY_STATE_HTTP_URL_ENV} is required`);
  } else if (!/^https:\/\//.test(httpActionsUrl)) {
    errors.push(`${GALLERY_STATE_HTTP_URL_ENV} must be an https URL`);
  } else if (/\.convex\.cloud/.test(httpActionsUrl)) {
    errors.push(
      `${GALLERY_STATE_HTTP_URL_ENV} must be the HTTP actions host (.convex.site), not .convex.cloud`
    );
  }

  if (!secret) errors.push(`${GALLERY_STATE_SECRET_ENV} is required`);

  return { ok: errors.length === 0, errors };
}

function requireConfig({ httpActionsUrl, secret }) {
  if (typeof httpActionsUrl !== "string" || !/^https:\/\//.test(httpActionsUrl)) {
    throw new Error("A Convex HTTP actions https URL is required");
  }
  // The HTTP routes live on the deployment's .convex.site domain, NOT the
  // .convex.cloud one that queries and mutations use. Pointing this at the
  // wrong host is a silent 404, so it is rejected here rather than at runtime.
  if (/\.convex\.cloud(\/|$)/.test(httpActionsUrl)) {
    throw new Error("Use the HTTP actions URL (.convex.site), not the .convex.cloud deployment URL");
  }
  // Fail closed at construction: an adapter without a secret must never be
  // able to make a request that is silently unauthenticated.
  if (typeof secret !== "string" || !secret) {
    throw new Error(`${GALLERY_STATE_SECRET_ENV} is required for gallery state persistence`);
  }
  return { base: httpActionsUrl.replace(/\/+$/, ""), secret };
}

/**
 * A store backed by the dedicated Koff Convex deployment, reached through its
 * authenticated HTTP boundary.
 *
 * Implements the same load()/save() contract as the file and memory stores, so
 * the runtime pass does not know or care which one it was handed - plus
 * bootstrap(), which is what actually seeds a fresh deployment.
 */
export function createConvexGalleryStateStore({
  httpActionsUrl,
  secret,
  fetchImpl = globalThis.fetch,
  batchSize = DEFAULT_BATCH_SIZE,
  pageSize = DEFAULT_PAGE_SIZE,
} = {}) {
  const { base } = requireConfig({ httpActionsUrl, secret });
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  async function call(path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [GALLERY_STATE_SECRET_HEADER]: secret,
      },
      body: JSON.stringify(body ?? {}),
    });
    if (response.status === 401) {
      // Deliberately does not echo either secret, or the header.
      throw new Error("Gallery state request was rejected (401) - check KOFF_GALLERY_STATE_SECRET");
    }
    if (!response.ok) {
      throw new Error(`Gallery state request failed with HTTP ${response.status}`);
    }
    return await response.json();
  }

  async function readMeta() {
    const { meta } = await call("/gallery-state/meta/read", {});
    return meta ?? null;
  }

  async function readAllRows() {
    const rows = [];
    let cursor = null;
    for (;;) {
      const page = await call("/gallery-state/page", { cursor, numItems: pageSize });
      if (Array.isArray(page?.page)) rows.push(...page.page);
      if (page?.isDone) break;
      if (!page?.continueCursor) break;
      cursor = page.continueCursor;
    }
    return rows;
  }

  async function writeRows(rows) {
    let inserted = 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const result = await call("/gallery-state/batch", { rows: batch });
      inserted += result?.inserted ?? 0;
      updated += result?.updated ?? 0;
    }
    return { inserted, updated, written: rows.length, batches: Math.ceil(rows.length / batchSize) };
  }

  async function writeMeta(meta) {
    return await call("/gallery-state/meta/write", {
      schemaVersion: meta.schemaVersion,
      bootstrapCompleted: meta.bootstrapCompleted,
      bootstrapRunId: meta.bootstrapRunId ?? null,
      bootstrapCompletedAt: meta.bootstrapCompletedAt ?? null,
      updatedAt: meta.updatedAt,
    });
  }

  return {
    kind: "convex",
    location: "koff-side convex deployment",

    async load() {
      const meta = await readMeta();
      const rows = await readAllRows();
      // When the deployment has neither, report the empty shape so the planner
      // sees unusable meta and ABORTS rather than fetching the whole catalog.
      if (!meta && rows.length === 0) return emptyGalleryState();
      return coerceGalleryState({ meta, rows });
    },

    async save(state) {
      const { meta, rows } = coerceGalleryState(state);
      const written = await writeRows(rows);
      if (meta) await writeMeta(meta);
      return { written: true, location: "koff-side convex deployment", ...written };
    },

    /**
     * Seed a fresh deployment from an already-captured artifact.
     *
     * ORDER MATTERS: rows first, meta LAST. `bootstrapCompleted` is what lets a
     * normal run proceed incrementally, so writing it before the rows landed
     * would declare an incomplete state complete - and a run against it would
     * queue detail requests for every product that had not been written yet.
     * A failure part-way leaves meta unset, which aborts the next run safely
     * instead of being mistaken for a finished import.
     */
    async bootstrap({ rows, meta } = {}) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("bootstrap requires rows to import");
      }
      const written = await writeRows(rows);
      const metaResult = await writeMeta(meta);
      return { ...written, meta: metaResult, metaWrittenAfterRows: true };
    },

    /**
     * Counts as the deployment holds them.
     *
     * Computed by WALKING PAGES on the client, never by a server-side
     * aggregate: a single Convex execution cannot scan 28k rows inside its
     * 16MB read limit, so an aggregate query here would either fail on the
     * real state or silently truncate it.
     */
    async stats() {
      let count = 0;
      let images = 0;
      const byStatus = {};
      let cursor = null;
      for (;;) {
        const page = await call("/gallery-state/page", { cursor, numItems: pageSize });
        const rows = Array.isArray(page?.page) ? page.page : [];
        for (const row of rows) {
          count++;
          images += Array.isArray(row.galleryUrls) ? row.galleryUrls.length : 0;
          byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
        }
        if (page?.isDone) break;
        if (!page?.continueCursor) break;
        cursor = page.continueCursor;
      }
      return { count, images, byStatus };
    },

    /** Read every row via pages - the round-trip verification source. */
    async allRows() {
      return await readAllRows();
    },
  };
}

/** Schema version this build writes. */
export const CONVEX_GALLERY_SCHEMA_VERSION = GALLERY_STATE_SCHEMA_VERSION;
