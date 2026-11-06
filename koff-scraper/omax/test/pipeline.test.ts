import { describe, expect, test } from "vitest";
import { createOmaxClient, isForbiddenUrl, parseLoginForm } from "../src/client.js";
import { pageUrl, scrape, type DetailCache } from "../src/cli.js";
import { ModelIndex } from "../src/models.js";
import { buildShopRow, codeOf, colourOf, makerOf, type ScrapedProduct } from "../src/shop-row.js";
import { needsFullResend, planDiff, rowHash, runSync, type Snapshot } from "../src/sync.js";

const MODELS = [
  { brand: "Apple", name: "iPhone 11 Pro Max" }, { brand: "Apple", name: "iPhone XS Max" },
  { brand: "Apple", name: "iPhone 16" }, { brand: "Apple", name: "iPhone 15" },
  { brand: "Samsung", name: "A55 5G" }, { brand: "Xiaomi", name: "Redmi Note 12 5G" },
];
const index = new ModelIndex(MODELS);
const product = (o: Partial<ScrapedProduct> = {}): ScrapedProduct => ({
  productId: 26079, name: "OG Tempered Glass Apple iPhone 11 Pro Max/Xs Max /черно/", href: "/bg/product/26079/x/og/",
  priceEur: 1.3, kind: "screen", categoryPath: "Протектори / С рамка / OG", ean: "3800165037517",
  images: ["https://cdn.omax.bg/images/products/full/a.jpg"], description: "", ...o,
});

describe("shop row", () => {
  test("phone accessory: name, models, floors, stock 5", () => {
    const r = buildShopRow(product(), index);
    expect("row" in r && r.row).toMatchObject({
      sourceKey: "omax-sync:26079", proposedName: "Стъклен протектор OG за iPhone 11 Pro Max - черно",
      brand: "Apple", model: "iPhone 11 Pro Max", compat: [{ brand: "Apple", model: "iPhone XS Max" }],
      stock: 5, priceB2C: 9.99, costPrice: 1.3, category: "protektori-za-ekran",
      supplierUrl: "https://b2b.omax.bg/bg/product/26079/x/og/",
    });
  });
  test("price already with VAT: the shop price is not ×1.23", () => {
    const a = buildShopRow(product({ priceEur: 20 }), index);
    const b = buildShopRow(product({ priceEur: 20 * 1.23 }), index);
    expect("row" in a && "row" in b && a.row.priceB2C < b.row.priceB2C).toBe(true);
  });
  test("a phone the shop does not have is not uploaded", () => {
    expect(buildShopRow(product({ name: "Калъф Apple iPhone 3G /черен/", kind: "case" }), index)).toEqual({ skip: "телефонът не е в магазина" });
  });
  test("no picture or no price: skipped", () => {
    expect(buildShopRow(product({ images: [] }), index)).toEqual({ skip: "няма снимка" });
    expect(buildShopRow(product({ priceEur: 0 }), index)).toEqual({ skip: "няма цена" });
  });
  test("a camera glass listed under screen protectors goes to camera protectors", () => {
    const r = buildShopRow(product({ name: "Camera Lens Glass Apple iPhone 16 /iPhone 15" }), index);
    expect("row" in r && r.row.category).toBe("protektori-za-kamera");
  });
  test("charger: maker brand, all models, code", () => {
    const r = buildShopRow(product({ name: "Кабел HOCO X14 USB-A към Lightning 1m /черен/ - X14", kind: "cable" }), index);
    expect("row" in r && r.row).toMatchObject({ brand: "Hoco", model: "Всички модели", supplierSku: "X14", publicMaker: "Hoco",
      proposedName: "Кабел HOCO X14 USB-A към Lightning 1m - черен", category: "kabeli-za-zaryadane" });
  });
  test("helpers", () => {
    expect(codeOf("LDNIO Зарядно 20W - A2318M")).toBe("A2318M");
    expect(codeOf("Калъф Apple iPhone 16 - черен")).toBe("");
    expect(colourOf("Калъф Carbon Xiaomi RedMi Note 12 5G/Poco X5 5G /черен/ NORDIC")).toBe("черен");
    expect(makerOf("Калъф Carbon ... NORDIC")).toBe("Nordic");
  });
});

// ---------------------------------------------------------------------------
const LOGGED_OUT = `<html><form action="/bg/login/" method="post"><input type="hidden" name="token" value="t1"><input name="email"><input type="password" name="password"></form></html>`;
const LOGGED_IN = (body = "") => `<html><a href="/bg/login/logout/">Изход</a>${body}</html>`;

function fakeSite(pages: Record<string, string>) {
  const calls: { method: string; path: string; body?: string; cookie?: string }[] = [];
  let signedIn = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path, body: init.body as string, cookie: new Headers(init.headers).get("cookie") ?? undefined });
    if (method === "POST" && path === "/bg/login/") {
      const ok = /email=a%40b.bg/.test(String(init.body)) && /password=pw/.test(String(init.body)) && /token=t1/.test(String(init.body));
      signedIn = ok;
      return new Response("", { status: 302, headers: { location: "/bg/", "set-cookie": "PHPSESSID=s1; path=/" } });
    }
    if (!signedIn) return new Response(LOGGED_OUT, { status: 200 });
    const page = pages[path];
    return page === undefined ? new Response("nf", { status: 404 }) : new Response(LOGGED_IN(page), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, expire: () => { signedIn = false; } };
}

describe("client", () => {
  test("login form with hidden fields; the logout address is never opened", async () => {
    expect(parseLoginForm(LOGGED_OUT)).toEqual({ action: "/bg/login/", fields: { token: "t1" } });
    expect(isForbiddenUrl("https://b2b.omax.bg/bg/login/logout/")).toBe(true);
    const site = fakeSite({ "/bg/": "home" });
    const client = createOmaxClient({ email: "a@b.bg", password: "pw", fetchImpl: site.fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    await client.login();
    await expect(client.fetchText("/bg/login/logout/")).rejects.toThrow(/изход/);
    expect(site.calls.some((c) => /logout/.test(c.path))).toBe(false);
    expect(site.calls.at(-1)?.cookie).toContain("PHPSESSID=s1");
  });
  test("wrong password stops with a clear message", async () => {
    const site = fakeSite({ "/bg/": "home" });
    const client = createOmaxClient({ email: "a@b.bg", password: "bad", fetchImpl: site.fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    await expect(client.login()).rejects.toThrow(/OMAX_EMAIL/);
  });
  test("an expired session logs in again once", async () => {
    const site = fakeSite({ "/bg/": "home", "/bg/x/": "page" });
    const client = createOmaxClient({ email: "a@b.bg", password: "pw", fetchImpl: site.fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    await client.login();
    site.expire();
    expect(await client.fetchSignedIn("/bg/x/")).toContain("page");
  });
  test("requests outside the site are refused", async () => {
    const client = createOmaxClient({ email: "a@b.bg", password: "pw", fetchImpl: fakeSite({}).fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    await expect(client.fetchText("https://example.com/")).rejects.toThrow(/извън/);
  });
});

// ---------------------------------------------------------------------------
const MENU = `<ul><li class="dropdown-submenu"><a href="/bg/products/9/kalafi/">Калъфи</a>
  <ul class="menu-column"><li><a href="/bg/products/10/silikon/"><b>Силиконови</b></a></li></ul></li></ul>`;
const row = (id: number, inStock: boolean) => `<div class="row-stripedd">
  <div><a href="/bg/product/${id}/10/p${id}/"><img class="product-thumb" alt="Калъф Apple iPhone 16 /черен/" src="t.jpg"></a></div>
  <div>${inStock ? "2.50 EUR" : ""}</div>${inStock ? '<div><button class="addToCart">+</button></div>' : "<div>out of stock</div>"}</div>`;
const DETAIL = `<span itemprop="gtin13">3800000000001</span><a class="main-pics" href="https://cdn.omax.bg/images/products/full/1.jpg"></a><div itemprop="description">Описание</div>`;

describe("scrape", () => {
  test("page URLs", () => {
    expect(pageUrl("/bg/products/10/silikon/", 1)).toBe("/bg/products/10/silikon/");
    expect(pageUrl("/bg/products/10/silikon/", 3)).toBe("/bg/products/10/silikon/3");
  });
  test("stops at the first sold-out row; reads only new product pages, up to the cap", async () => {
    const site = fakeSite({
      "/bg/": MENU,
      "/bg/products/10/silikon/": [1, 2, 3].map((i) => row(i, true)).join("") + `<a href="/products/10/silikon/2">2</a>`,
      "/bg/products/10/silikon/2": row(4, true) + row(5, false) + `<a href="/products/10/silikon/3">3</a>`,
      "/bg/product/2/10/p2/": DETAIL, "/bg/product/3/10/p3/": DETAIL, "/bg/product/4/10/p4/": DETAIL,
    });
    const client = createOmaxClient({ email: "a@b.bg", password: "pw", fetchImpl: site.fetchImpl, sleep: async () => {}, minIntervalMs: 0 });
    await client.login();
    const cache: DetailCache = { 1: { ean: "", images: ["https://cdn.omax.bg/c.jpg"], description: "", fetchedAt: new Date().toISOString() } };
    const res = await scrape(client, cache, { detailCap: 2, maxAgeDays: 30 });
    expect(res.products.map((p) => p.productId).sort()).toEqual([1, 2, 3]);
    expect(res.deferred).toEqual([4]);
    expect(site.calls.some((c) => c.path.endsWith("/3"))).toBe(false); // page 3 not read
    expect(site.calls.some((c) => c.path === "/bg/product/1/10/p1/")).toBe(false); // cached
    expect(res.products.find((p) => p.productId === 2)).toMatchObject({ ean: "3800000000001", priceEur: 2.5, kind: "case" });
  });
});

// ---------------------------------------------------------------------------
const MANY_MODELS = [...MODELS, ...Array.from({ length: 120 }, (_, i) => ({ brand: "Apple", name: `iPhone X${i}` }))];
const feed = (n: number, price = 1.3) => Array.from({ length: n }, (_, i) => product({ productId: 1000 + i, ean: "", priceEur: price }));

function fakeConvex(previous: any = null, synced: string[] = []) {
  const calls: { name: string; args: any }[] = [];
  return {
    calls,
    deps: {
      mutation: async (name: string, args: any) => {
        calls.push({ name, args });
        if (name === "omaxSync:applyBatch") return { created: args.rows.length, changed: 0, unchanged: 0, groupKeys: [], categories: {}, newBrands: [], samples: [] };
        if (name === "omaxSync:zeroStockByKeys") return { zeroed: args.dryRun ? 0 : args.sourceKeys.length, wouldZero: args.dryRun ? args.sourceKeys.length : 0 };
        if (name === "omaxSync:buildGroupsForKeys") return { checked: 0, created: 0, refreshed: 0, withMembers: 0, dryRun: args.dryRun };
        return {};
      },
      query: async (name: string) => {
        calls.push({ name, args: {} });
        if (name === "omaxSync:previousRun") return previous;
        if (name === "omaxSync:pageSyncedProducts") return { products: synced.map((k) => ({ productId: k, sourceKey: k, stock: 5 })), isDone: true, continueCursor: "" };
        return null;
      },
    },
  };
}
const sent = (calls: { name: string; args: any }[]) => calls.filter((c) => c.name === "omaxSync:applyBatch").flatMap((c) => c.args.rows);
const zeroedKeys = (calls: { name: string; args: any }[]) => calls.filter((c) => c.name === "omaxSync:zeroStockByKeys").flatMap((c) => c.args.sourceKeys);

describe("sync", () => {
  test("dry by default; first run sends all and zeroes by paging only Omax rows", async () => {
    const cx = fakeConvex(null, ["omax-sync:1000", "omax-sync:9"]);
    const { report, nextSnapshot } = await runSync({ products: feed(60), deferred: [] }, MANY_MODELS, null, { live: false }, cx.deps);
    expect(report.mode).toBe("dry");
    expect(sent(cx.calls)).toHaveLength(60);
    expect(cx.calls.filter((c) => c.name === "omaxSync:applyBatch").every((c) => c.args.dryRun === true)).toBe(true);
    expect(zeroedKeys(cx.calls)).toEqual(["omax-sync:9"]);
    expect(Object.keys(nextSnapshot.rows)).toHaveLength(60);
  });

  test("with a snapshot: only changed rows are sent, the gone ones zeroed by key (no paging)", async () => {
    const products = feed(60);
    const first = await runSync({ products, deferred: [] }, MANY_MODELS, null, { live: true }, fakeConvex().deps);
    const changed = products.slice(0, 59).map((p, i) => (i === 0 ? { ...p, priceEur: 30 } : p));
    const cx = fakeConvex({ feedKeys: 60, stockZeroMode: "applied" });
    const { report, nextSnapshot } = await runSync({ products: changed, deferred: [] }, MANY_MODELS, first.nextSnapshot, { live: true }, cx.deps);
    expect(report.sent).toBe(1);
    expect(sent(cx.calls).map((r: any) => r.sourceKey)).toEqual(["omax-sync:1000"]);
    expect(zeroedKeys(cx.calls)).toEqual(["omax-sync:1059"]);
    expect(cx.calls.some((c) => c.name === "omaxSync:pageSyncedProducts")).toBe(false);
    expect(nextSnapshot.rows["omax-sync:1059"]).toBeUndefined();
  });

  test("an unchanged feed costs no write at all", async () => {
    const products = feed(60);
    const first = await runSync({ products, deferred: [] }, MANY_MODELS, null, { live: true }, fakeConvex().deps);
    const cx = fakeConvex({ feedKeys: 60, stockZeroMode: "applied" });
    await runSync({ products, deferred: [] }, MANY_MODELS, first.nextSnapshot, { live: true }, cx.deps);
    expect(sent(cx.calls)).toHaveLength(0);
    expect(zeroedKeys(cx.calls)).toHaveLength(0);
  });

  test("deferred products (page not read yet) are not zeroed", async () => {
    const products = feed(60);
    const first = await runSync({ products, deferred: [] }, MANY_MODELS, null, { live: true }, fakeConvex().deps);
    const cx = fakeConvex({ feedKeys: 60, stockZeroMode: "applied" });
    await runSync({ products: products.slice(0, 59), deferred: [1059] }, MANY_MODELS, first.nextSnapshot, { live: true }, cx.deps);
    expect(zeroedKeys(cx.calls)).toHaveLength(0);
  });

  test("a feed drop never zeroes; too few products never touches the shop", async () => {
    const snap: Snapshot = { fullAt: new Date().toISOString(), rows: Object.fromEntries(feed(200).map((p) => [`omax-sync:${p.productId}`, "x"])) };
    const cx = fakeConvex({ feedKeys: 200, stockZeroMode: "applied" });
    const { report } = await runSync({ products: feed(60), deferred: [] }, MANY_MODELS, snap, { live: true }, cx.deps);
    expect(report.stock.mode).toBe("skipped-feed-drop");
    expect(zeroedKeys(cx.calls)).toHaveLength(0);
    const cx2 = fakeConvex();
    await expect(runSync({ products: feed(10), deferred: [] }, MANY_MODELS, null, { live: true }, cx2.deps)).rejects.toThrow(/НЕ е пипнат/);
    expect(cx2.calls).toHaveLength(0);
  });

  test("weekly full resend", () => {
    const now = Date.parse("2026-11-20T11:00:00Z");
    expect(needsFullResend(null, now, false)).toBe(true);
    expect(needsFullResend({ fullAt: "2026-11-18T11:00:00Z", rows: {} }, now, false)).toBe(false);
    expect(needsFullResend({ fullAt: "2026-11-10T11:00:00Z", rows: {} }, now, false)).toBe(true);
    const r = buildShopRow(product(), index);
    if (!("row" in r)) throw new Error("no row");
    const snap = { fullAt: "x", rows: { [r.row.sourceKey]: rowHash(r.row) } };
    expect(planDiff([r.row], snap, new Set(), false).send).toHaveLength(0);
    expect(planDiff([r.row], snap, new Set(), true).send).toHaveLength(1);
  });

  test("a group batch that is too big is split in half and sent again", async () => {
    const cx = fakeConvex();
    const seen: number[] = [];
    const deps = {
      ...cx.deps,
      mutation: async (name: string, args: any) => {
        if (name === "omaxSync:applyBatch") return { created: args.rows.length, groupKeys: args.rows.map((r: any) => r.sourceKey) };
        if (name === "omaxSync:buildGroupsForKeys") {
          seen.push(args.keys.length);
          if (args.keys.length > 30) throw new Error("Your request timed out performing too many system operations.");
          return { checked: args.keys.length, created: 0, refreshed: 0, withMembers: 0, dryRun: true };
        }
        return cx.deps.mutation(name, args);
      },
    };
    const { report } = await runSync({ products: feed(120), deferred: [] }, MANY_MODELS, null, { live: false }, deps);
    expect(report.groups.checked).toBe(120);
    expect(Math.max(...seen)).toBe(100);
  });
});
