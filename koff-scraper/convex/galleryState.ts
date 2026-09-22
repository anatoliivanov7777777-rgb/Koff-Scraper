// Koff-side gallery state: persistence only.
//
// The planner (koff-scraper/scraper/gallery-state.mjs) remains the single
// source of policy - which products need a detail request, when to abort, how
// a failure is recorded. Nothing in this file makes a scheduling or fetching
// decision; it stores and returns what the planner produced.
//
// Deliberately NOT keyed by anything but the RAW Koff product id. One raw
// product expands into several CaseKing storefront rows, so a variant name,
// slug or product name must never key this table.
//
// NOTE: these functions are not deployed by the change that added them. The
// Koff-side Convex deployment has not been proven or authorised yet.

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const META_KEY = "gallery";

const galleryRowValidator = v.object({
  sourceProductId: v.number(),
  sourceId: v.union(v.string(), v.null()),
  coverIdentity: v.union(v.string(), v.null()),
  galleryUrls: v.array(v.string()),
  galleryFingerprint: v.union(v.string(), v.null()),
  lastSuccessfulFetchAt: v.union(v.number(), v.null()),
  lastAttemptAt: v.union(v.number(), v.null()),
  lastFailureAt: v.union(v.number(), v.null()),
  failureCount: v.number(),
  status: v.union(v.literal("ready"), v.literal("failed"), v.literal("missing")),
});

/** The global gallery metadata, or null when the deployment has none yet. */
export const getGalleryMeta = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("galleryMeta")
      .withIndex("by_key", (q) => q.eq("key", META_KEY))
      .first();
    if (!row) return null;
    return {
      schemaVersion: row.schemaVersion,
      bootstrapCompleted: row.bootstrapCompleted,
      bootstrapRunId: row.bootstrapRunId ?? null,
      bootstrapCompletedAt: row.bootstrapCompletedAt ?? null,
      updatedAt: row.updatedAt,
    };
  },
});

/**
 * One page of gallery state rows.
 *
 * Paginated on purpose: 28k rows cannot be collected inside Convex's 16MB
 * per-execution read limit, so the store walks pages rather than asking for
 * everything at once.
 */
export const getGalleryStatePage = query({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("galleryState").paginate({
      cursor: args.cursor ?? null,
      numItems: Math.max(1, Math.min(args.numItems, 1000)),
    });
    return {
      page: result.page.map((row) => ({
        sourceProductId: row.sourceProductId,
        sourceId: row.sourceId ?? null,
        coverIdentity: row.coverIdentity ?? null,
        galleryUrls: row.galleryUrls,
        galleryFingerprint: row.galleryFingerprint ?? null,
        lastSuccessfulFetchAt: row.lastSuccessfulFetchAt ?? null,
        lastAttemptAt: row.lastAttemptAt ?? null,
        lastFailureAt: row.lastFailureAt ?? null,
        failureCount: row.failureCount,
        status: row.status,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/** Rows currently held, and the total gallery URLs they carry. */
export const getGalleryStateStats = query({
  args: {},
  handler: async (ctx) => {
    let count = 0;
    let images = 0;
    // Bounded scan: same reason as above - never collect the whole table.
    for await (const row of ctx.db.query("galleryState")) {
      count++;
      images += Array.isArray(row.galleryUrls) ? row.galleryUrls.length : 0;
      if (count > 200000) break;
    }
    return { count, images };
  },
});

/**
 * Upsert a bounded batch of rows.
 *
 * Bounded by the caller so a single Convex mutation never has to write 28k
 * documents. Idempotent per sourceProductId - re-running an import converges
 * on the same state rather than duplicating rows.
 */
export const upsertGalleryStateBatch = mutation({
  args: { rows: v.array(galleryRowValidator) },
  handler: async (ctx, args) => {
    let inserted = 0;
    let updated = 0;
    for (const row of args.rows) {
      const existing = await ctx.db
        .query("galleryState")
        .withIndex("by_sourceProductId", (q) => q.eq("sourceProductId", row.sourceProductId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, row);
        updated++;
      } else {
        await ctx.db.insert("galleryState", row);
        inserted++;
      }
    }
    return { inserted, updated, processed: args.rows.length };
  },
});

/**
 * Write the global meta.
 *
 * The bootstrap flow calls this LAST, and only after every expected row has
 * been written - that ordering is what makes `bootstrapCompleted` mean "the
 * state is complete" rather than "an import was attempted".
 */
export const setGalleryMeta = mutation({
  args: {
    schemaVersion: v.number(),
    bootstrapCompleted: v.boolean(),
    bootstrapRunId: v.union(v.string(), v.null()),
    bootstrapCompletedAt: v.union(v.number(), v.null()),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("galleryMeta")
      .withIndex("by_key", (q) => q.eq("key", META_KEY))
      .first();
    const fields = {
      key: META_KEY,
      schemaVersion: args.schemaVersion,
      bootstrapCompleted: args.bootstrapCompleted,
      bootstrapRunId: args.bootstrapRunId,
      bootstrapCompletedAt: args.bootstrapCompletedAt,
      updatedAt: args.updatedAt,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return { updated: true };
    }
    await ctx.db.insert("galleryMeta", fields);
    return { updated: false };
  },
});
