import { describe, expect, it } from "vitest";
import { isFeedDrop, runSync } from "../src/sync.js";
import type { ScrapedProduct } from "../src/core.js";

function products(n: number): ScrapedProduct[] {
  return Array.from({ length: n }, (_, i) => ({
    productId: String(1000 + i),
    url: "",
    categoryPath: "496_570",
    categoryName: "Оригинални кабели",
    brand: "PHILIPS",
    name: `Кабел PHILIPS USB-C към USB-C ${i}`,
    model: "",
    sku: "",
    ean: "",
    priceEur: 3.9,
    inStock: true,
    images: [],
    attributes: {},
    description: "",
  }));
}

function fakeConvex(previous: any = null, synced: any[] = []) {
  const calls: { name: string; args: any }[] = [];
  return {
    calls,
    deps: {
      mutation: async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === "lstarSync:applyBatch") {
          return { created: args.rows.length, changed: 0, unchanged: 0, hidden: 0, foreign: 0, eanViaCode: 0, koffNamed: 0, categories: {}, newBrands: [], newModels: [], samples: [], groupKeys: [] };
        }
        if (name === "lstarSync:zeroStockNotInFeed") return { zeroed: args.dryRun ? 0 : args.rows.length, wouldZero: args.dryRun ? args.rows.length : 0 };
        if (name === "lstarSync:buildGroupsForKeys") return { checked: args.keys.length, created: 0, refreshed: 0, withMembers: 0, dryRun: true };
        return { id: "run" };
      },
      query: async (name: string) => {
        if (name === "lstarSync:previousRun") return previous;
        return { products: synced, isDone: true, continueCursor: "" };
      },
    },
  };
}

describe("runSync", () => {
  it("dry by default: every write call carries dryRun", async () => {
    const { calls, deps } = fakeConvex(null, [{ productId: "p1", sourceKey: "lstar-sync:1", stock: 5 }]);
    const report = await runSync(products(60), { live: false, stockZeroApply: true }, deps);
    expect(report.mode).toBe("dry");
    expect(calls.filter((c) => c.name === "lstarSync:applyBatch").every((c) => c.args.dryRun === true)).toBe(true);
    expect(calls.find((c) => c.name === "lstarSync:zeroStockNotInFeed")!.args.dryRun).toBe(true);
    expect(report.stock).toMatchObject({ mode: "dry", notInFeed: 1, wouldZero: 1, zeroed: 0 });
  });

  it("batches of 200 rows", async () => {
    const { calls, deps } = fakeConvex();
    await runSync(products(450), { live: true, stockZeroApply: false }, deps);
    expect(calls.filter((c) => c.name === "lstarSync:applyBatch").map((c) => c.args.rows.length)).toEqual([200, 200, 50]);
  });

  it("zeroes only when LIVE and STOCK_ZERO_MODE=apply", async () => {
    const synced = [{ productId: "p1", sourceKey: "lstar-sync:1", stock: 5 }, { productId: "p2", sourceKey: "lstar-sync:1000", stock: 5 }];
    const { calls, deps } = fakeConvex({ feedKeys: 60, stockZeroMode: "applied" }, synced);
    const report = await runSync(products(60), { live: true, stockZeroApply: true }, deps);
    const zero = calls.find((c) => c.name === "lstarSync:zeroStockNotInFeed")!;
    expect(zero.args).toMatchObject({ dryRun: false, rows: [{ productId: "p1", expectedSourceKey: "lstar-sync:1" }] });
    expect(report.stock).toMatchObject({ mode: "applied", zeroed: 1 });
  });

  it("a shrunken list never empties the shop", async () => {
    const { calls, deps } = fakeConvex({ feedKeys: 108, stockZeroMode: "applied" }, [{ productId: "p1", sourceKey: "lstar-sync:1", stock: 5 }]);
    const report = await runSync(products(60), { live: true, stockZeroApply: true }, deps);
    expect(report.stock.mode).toBe("skipped-feed-drop");
    expect(calls.some((c) => c.name === "lstarSync:zeroStockNotInFeed")).toBe(false);
    expect(calls.find((c) => c.name === "lstarSync:recordRun")!.args.run.stockZeroMode).toBe("skipped-feed-drop");
  });

  it("stops before touching the shop when the scrape looks broken", async () => {
    const { calls, deps } = fakeConvex();
    await expect(runSync(products(10), { live: true, stockZeroApply: true }, deps)).rejects.toThrow(/НЕ е пипнат/);
    expect(calls).toHaveLength(0);
  });

  it("isFeedDrop: under 90 % of the last good run", () => {
    expect(isFeedDrop(98, 108)).toBe(false);
    expect(isFeedDrop(97, 108)).toBe(true); // 97 < 97.2
    expect(isFeedDrop(5, undefined)).toBe(false);
  });
});
