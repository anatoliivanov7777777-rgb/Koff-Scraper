import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Надценки - лесно променяеми на едно място
export const B2B_MARKUP = 1.6; // +60%
export const B2C_MARKUP = 1.8; // +80%

// Upsert на един продукт (извиква се от HTTP action-а по-долу)
export const upsertProduct = internalMutation({
  args: {
    sourceId: v.string(),
    name: v.string(),
    description: v.string(),
    basePrice: v.number(),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("products")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
      .unique();

    const doc = {
      sourceId: args.sourceId,
      name: args.name,
      description: args.description,
      basePrice: args.basePrice,
      priceB2B: Math.round(args.basePrice * B2B_MARKUP * 100) / 100,
      priceB2C: Math.round(args.basePrice * B2C_MARKUP * 100) / 100,
      imageUrl: args.imageUrl,
      lastSeenAt: Date.now(),
      active: true,
    };

    if (existing) {
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("products", doc);
    }
  },
});

// Маркира като неактивни продуктите, които не са били видени в последния run
// (т.е. вероятно вече не съществуват в koff.ro). Ползва индекс вместо пълно
// сканиране на таблицата, и ограничава броя наведнъж, за да не удря лимита
// на Convex за брой четения в едно извикване (4096).
export const deactivateStale = internalMutation({
  args: { cutoffTimestamp: v.number() },
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("products")
      .withIndex("by_lastSeenAt", (q) => q.lt("lastSeenAt", args.cutoffTimestamp))
      .filter((q) => q.eq(q.field("active"), true))
      .take(2000);

    for (const p of stale) {
      await ctx.db.patch(p._id, { active: false });
    }
    return { deactivated: stale.length, mayHaveMore: stale.length === 2000 };
  },
});

// Публична заявка за фронтенда ти - връща само активните продукти
export const listActive = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("products")
      .filter((q) => q.eq(q.field("active"), true))
      .collect();
  },
});
