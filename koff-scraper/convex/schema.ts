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
    lastSeenAt: v.number(),
    active: v.boolean(),
  })
    .index("by_sourceId", ["sourceId"])
    .index("by_lastSeenAt", ["lastSeenAt"]),
});
