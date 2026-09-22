// Durable gallery-state persistence.
//
// The planner in gallery-state.mjs is pure and knows nothing about where state
// lives. This module is the seam: a small async interface, plus the two
// implementations this repo needs today.
//
//   createFileGalleryStateStore(path)   - durable, zero infrastructure
//   createMemoryGalleryStateStore()     - tests / dry runs
//
// WHY A FILE STORE AND NOT CONVEX (yet)
// The Koff-side Convex schema has the tables for this (see
// koff-scraper/convex/schema.ts), but no deployment of it has been proven or
// authorised for gallery state. Rather than guess a deployment or make the
// weekly run depend on one that is not yet verified, the runtime persists to a
// JSON file it owns. A Convex-backed store can implement this same interface
// later without touching the planner or its tests.
//
// The store is deliberately dumb: it loads and saves. Every decision lives in
// gallery-state.mjs, which is why the policy is testable without touching disk.

import fs from "node:fs";
import path from "node:path";
import { applyGalleryResults, planGalleryRefresh } from "./gallery-state.mjs";

/** The state container as read from / written to storage. */
export function emptyGalleryState() {
  return { meta: null, rows: [] };
}

/**
 * Accepts every shape a store might hand back - a parsed object, or raw JSON
 * text - and returns { meta, rows }. Never throws: unrecognized input becomes
 * empty state, which the planner then treats as "unusable" and aborts on
 * rather than mis-reading as "no cached galleries exist, fetch everything".
 */
export function coerceGalleryState(value) {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return emptyGalleryState();
    }
  }
  if (!parsed || typeof parsed !== "object") return emptyGalleryState();
  const meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : null;
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  return { meta, rows };
}

export function serializeGalleryState({ meta, rows }) {
  return JSON.stringify({ meta: meta ?? null, rows: rows ?? [] }, null, 2);
}

/**
 * Durable, file-backed store.
 *
 * Writes are atomic (temp file + rename) so a run killed mid-write cannot
 * leave a half-written state file behind - a truncated file would read as
 * corrupt meta and abort the next run, which is safe but annoying.
 */
export function createFileGalleryStateStore(filePath) {
  return {
    kind: "file",
    location: filePath,

    async load() {
      try {
        if (!fs.existsSync(filePath)) return emptyGalleryState();
        return coerceGalleryState(fs.readFileSync(filePath, "utf8"));
      } catch {
        // Unreadable state is reported as empty so the planner aborts on
        // unusable meta. It is never treated as "nothing is cached".
        return emptyGalleryState();
      }
    },

    async save(state) {
      const dir = path.dirname(filePath);
      if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, serializeGalleryState(state));
      fs.renameSync(tmp, filePath);
      return { written: true, location: filePath };
    },
  };
}

/** In-memory store for tests and dry runs. */
export function createMemoryGalleryStateStore(initial = emptyGalleryState()) {
  let state = coerceGalleryState(initial);
  return {
    kind: "memory",
    location: ":memory:",
    async load() {
      return state;
    },
    async save(next) {
      state = coerceGalleryState(next);
      return { written: true, location: ":memory:" };
    },
    peek() {
      return state;
    },
  };
}

/**
 * Run one incremental gallery pass against a store.
 *
 * This is the integration point the runtime uses: it owns the ORDER of
 * operations (load -> plan -> fetch candidates -> apply -> save) so no caller
 * can accidentally fetch before the guard has run, and it delegates every
 * actual request to the caller-supplied `fetchGalleries` - which is
 * product-gallery.mjs's fetchGalleriesBounded, and therefore the hardened
 * client with its 500ms pacing, safe-GET retries, 401/403 latch, concurrency
 * and telemetry. No second HTTP client exists here.
 *
 * On abort, `fetchGalleries` is not invoked at all, so zero detail requests
 * are made - the caller does not have to enforce that separately.
 */
export async function runIncrementalGalleryPass({
  store,
  catalog,
  fetchGalleries,
  now,
  fullRefresh = false,
  plan = null,
} = {}) {
  if (!store || typeof store.load !== "function" || typeof store.save !== "function") {
    throw new Error("A gallery state store with load()/save() is required");
  }
  if (typeof fetchGalleries !== "function") {
    throw new Error("fetchGalleries is required");
  }

  const state = await store.load();
  const planResult = plan
    ? plan({ catalog, state })
    : planGalleryRefresh({
      catalog,
      stateRows: state.rows,
      meta: state.meta,
      fullRefresh,
    });

  if (planResult.abort || planResult.candidates.length === 0) {
    return {
      plan: planResult,
      fetched: 0,
      results: new Map(),
      saved: false,
    };
  }

  const ids = planResult.candidates.map((candidate) => candidate.sourceProductId);
  const { galleries } = await fetchGalleries(ids);

  const rows = applyGalleryResults({
    stateRows: state.rows,
    catalog,
    results: galleries,
    now,
  });

  const meta = {
    ...(state.meta ?? {}),
    updatedAt: now,
  };

  await store.save({ meta, rows: [...rows.values()] });

  return {
    plan: planResult,
    fetched: ids.length,
    results: galleries,
    saved: true,
  };
}
