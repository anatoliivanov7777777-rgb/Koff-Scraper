import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    // Уникален идентификатор от koff.ro (SKU или URL slug) - използва се за upsert
    sourceId: v.string(),

    name: v.string(),
    description: v.string(),

    // Базовата (нетна, B2B изкупна) цена, както идва от koff.ro
    basePrice: v.number(),

    // Изчислени цени спрямо твоите надценки
    priceB2B: v.number(), // basePrice * 1.6
    priceB2C: v.number(), // basePrice * 1.8

    imageUrl: v.optional(v.string()),

    // За проследяване кога продуктът последно е видян/обновен от скрейпъра
    lastSeenAt: v.number(),

    // Ако продукт спре да се появява в koff.ro при следващ скрейп,
    // можем да го маркираме вместо да го трием директно
    active: v.boolean(),
  }).index("by_sourceId", ["sourceId"]),
});
