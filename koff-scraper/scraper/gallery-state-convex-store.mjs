// Convex-backed gallery state.
//
// Persistence ONLY. The planner in gallery-state.mjs still decides what to
// fetch; this file just makes the state durable across runs by storing it in
// the Koff-side Convex deployment instead of a file that dies with the CI
// runner.
//
// The Convex client is INJECTED, not constructed here. That keeps this module
// free of deployment knowledge (no URL, no credentials, no client library) and
// makes it testable offline against a fake - which is how the bootstrap and
// round-trip tests run without touching any deployment.

import { coerceGalleryState, emptyGalleryState, serializeGalleryState } from "./gallery-state-store.mjs";
import { GALLERY_STATE_SCHEMA_VERSION } from "./gallery-state.mjs";

/** Rows per Convex mutation. A full import is 28k+ rows, so it must be batched. */
export const DEFAULT_BATCH_SIZE = 200;

function requireClient(client) {
  if (!client || typeof client.query !== "function" || typeof client.mutation !== "function") {
    throw new Error("A Convex client with query() and mutation() is required");
  }
  return client;
}

/**
 * A store backed by the Koff-side Convex deployment.
 *
 * Implements the same load()/save() contract as the file and memory stores, so
 * the runtime pass does not know or care which one it was handed - plus
 * bootstrap(), which is what actually seeds a fresh deployment.
 */
export function createConvexGalleryStateStore({ client, batchSize = DEFAULT_BATCH_SIZE, pageSize = 500 } = {}) {
  const convex = requireClient(client);

  async function loadRows() {
    const rows = [];
    let cursor = null;
    for (;;) {
      const page = await convex.query("galleryState:getGalleryStatePage", {
        cursor,
        numItems: pageSize,
      });
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
      const result = await convex.mutation("galleryState:upsertGalleryStateBatch", { rows: batch });
      inserted += result?.inserted ?? 0;
      updated += result?.updated ?? 0;
    }
    return { inserted, updated, written: rows.length, batches: Math.ceil(rows.length / batchSize) };
  }

  async function writeMeta(meta) {
    return await convex.mutation("galleryState:setGalleryMeta", {
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
      const meta = await convex.query("galleryState:getGalleryMeta", {});
      const rows = await loadRows();
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
    async bootstrap({ rows, meta, batchSize: overrideBatch } = {}) {
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("bootstrap requires rows to import");
      }
      const previousBatch = batchSize;
      if (Number.isInteger(overrideBatch) && overrideBatch > 0) {
        // eslint-disable-next-line no-param-reassign
        batchSize = overrideBatch;
      }
      const written = await writeRows(rows);
      const metaResult = await writeMeta(meta);
      batchSize = previousBatch;
      return { ...written, meta: metaResult, metaWrittenAfterRows: true };
    },

    /** Counts as the deployment sees them - the round-trip verification source. */
    async stats() {
      return await convex.query("galleryState:getGalleryStateStats", {});
    },
  };
}

/**
 * Builds a minimal Convex client from an HTTP endpoint.
 *
 * Kept separate from the store so the store itself stays deployment-agnostic.
 * Nothing here is invoked by the change that added it - the Koff-side
 * deployment has not been proven or authorised yet, and this function is only
 * reachable once one is.
 */
export function createConvexHttpClientAdapter({ url, ConvexHttpClient }) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new Error("A Convex deployment https URL is required");
  }
  if (typeof ConvexHttpClient !== "function") {
    throw new Error("ConvexHttpClient constructor is required");
  }
  const http = new ConvexHttpClient(url);
  return {
    query: (name, args) => http.query(name, args),
    mutation: (name, args) => http.mutation(name, args),
  };
}

/** Serialize state for the deterministic checksum used in round-trip checks. */
export { serializeGalleryState };

/** Schema version this build writes. */
export const CONVEX_GALLERY_SCHEMA_VERSION = GALLERY_STATE_SCHEMA_VERSION;
