import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    sourceId: v.string(),
    name: v.string(),
    description: v.string(),
    basePrice: v.number(),
    priceB2B: v.number(),
    priceB2C: v.number(),

    imageUrl: v.optional(v.string()),
    category: v.optional(v.string()),
    manufacturer: v.optional(v.string()),

    lastSeenAt: v.number(),
    active: v.boolean(),
  })
    .index("by_sourceId", ["sourceId"])
    .index("by_lastSeenAt", ["lastSeenAt"])
    .index("by_category", ["category"]),

  categories: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),

  // Incremental gallery state.
  //
  // Keyed by the RAW Koff product id (sourceProductId). One raw Koff product
  // may expand into several CaseKing storefront rows, so this cannot be keyed
  // by a generated variant, slug or product name.
  //
  // Written by the scraper's gallery pass and read to decide which products
  // actually need a /api/product/:id detail request. The stored gallery is
  // what the run reuses for every product it does not re-fetch.
  galleryState: defineTable({
    sourceProductId: v.number(),
    sourceId: v.optional(v.union(v.string(), v.null())),
    // Cover identity from the catalog feed, normalized (query/fragment
    // stripped). A change here is the only per-run change signal the feed
    // reliably carries.
    coverIdentity: v.optional(v.union(v.string(), v.null())),
    galleryUrls: v.array(v.string()),
    galleryFingerprint: v.optional(v.union(v.string(), v.null())),
    lastSuccessfulFetchAt: v.optional(v.union(v.number(), v.null())),
    lastAttemptAt: v.optional(v.union(v.number(), v.null())),
    lastFailureAt: v.optional(v.union(v.number(), v.null())),
    failureCount: v.number(),
    status: v.union(v.literal("ready"), v.literal("failed"), v.literal("missing")),
  }).index("by_sourceProductId", ["sourceProductId"]),

  // Global gallery-state metadata (single row in practice).
  //
  // bootstrapCompleted is the switch the incremental planner reads: if this is
  // not true, a normal run ABORTS rather than treating "no state" as "fetch
  // the entire catalog".
  galleryMeta: defineTable({
    key: v.string(),
    schemaVersion: v.number(),
    bootstrapCompleted: v.boolean(),
    bootstrapRunId: v.optional(v.union(v.string(), v.null())),
    bootstrapCompletedAt: v.optional(v.union(v.number(), v.null())),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
