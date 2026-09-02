import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";

// Надценка: 60% за B2B / 80% за B2C, но ограничена между минимална и
// максимална абсолютна стойност в евро - за да не се получават нито твърде
// малки надценки при евтини продукти, нито твърде големи (непродаваеми)
// надценки при скъпи продукти. Средният диапазон продукти пази чиста
// процентна надценка, както досега.
const B2B_PERCENT = 0.6;
const B2B_MIN_MARKUP = 0.6;
const B2B_MAX_MARKUP = 8;

const B2C_PERCENT = 0.8;
const B2C_MIN_MARKUP = 2;
const B2C_MAX_MARKUP = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function calcB2BPrice(basePrice: number): number {
  const markup = clamp(basePrice * B2B_PERCENT, B2B_MIN_MARKUP, B2B_MAX_MARKUP);
  return Math.round((basePrice + markup) * 100) / 100;
}

function calcB2CPrice(basePrice: number): number {
  const markup = clamp(basePrice * B2C_PERCENT, B2C_MIN_MARKUP, B2C_MAX_MARKUP);
  return Math.round((basePrice + markup) * 100) / 100;
}

export const upsertProduct = internalMutation({
  args: {
    sourceId: v.string(),
    name: v.string(),
    description: v.string(),
    basePrice: v.number(),
    imageUrl: v.optional(v.string()),
    category: v.optional(v.string()),
    manufacturer: v.optional(v.string()),
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
      priceB2B: calcB2BPrice(args.basePrice),
      priceB2C: calcB2CPrice(args.basePrice),
      imageUrl: args.imageUrl,
      category: args.category,
      manufacturer: args.manufacturer,
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

export const upsertCategory = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("categories")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();
    if (!existing) {
      await ctx.db.insert("categories", { name: args.name });
    }
  },
});

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

// Странирано листване на активните продукти - каталогът е голям
// (~17-18 хиляди продукта), затова НЕ ползваме collect() (би ударило
// лимита на Convex за брой четения). Фронтендът тегли "страница по
// страница" (infinite scroll / бутон "Зареди още").
export const listActivePaginated = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("products")
      .filter((q) => q.eq(q.field("active"), true))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

// Продукти от конкретна категория, също странирано (някои родителски
// категории, напр. "Phone Cases", имат над 10 000 продукта).
export const listByCategoryPaginated = query({
  args: { category: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("products")
      .withIndex("by_category", (q) => q.eq("category", args.category))
      .filter((q) => q.eq(q.field("active"), true))
      .paginate(args.paginationOpts);
  },
});

// Списък с всички имена на категории - от отделната малка таблица,
// затова е бърза заявка дори при огромен каталог с продукти.
export const listCategories = query({
  args: {},
  handler: async (ctx) => {
    const cats = await ctx.db.query("categories").collect();
    return cats.map((c) => c.name).sort();
  },
});
