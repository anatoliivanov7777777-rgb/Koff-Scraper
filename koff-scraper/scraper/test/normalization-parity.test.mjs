import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as norm from "../caseking-product-normalization.mjs";

// ==========================================================================
// 1. The extracted module is genuinely side-effect free
// ==========================================================================

const SRC = readFileSync(new URL("../caseking-product-normalization.mjs", import.meta.url), "utf8");

test("importing the normalization module performs no side effect", () => {
  // Strip comments before scanning - the header explains the absence of these
  // things and would otherwise trip the check.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of [
    /process\.env/,
    /\bfetch\s*\(/,
    /\bawait\b/,
    /ConvexHttpClient/,
    /\bfs\./,
    /elated-butterfly-122/,
    /trustworthy-possum-230/,
    /aware-toucan-771/,
    /must point to the owned/,
  ]) {
    assert.doesNotMatch(code, forbidden, `normalization module must not contain ${forbidden}`);
  }
});

test("the module imports cleanly without any environment variable set", async () => {
  const saved = { ...process.env };
  delete process.env.CASEKING_CONVEX_URL;
  delete process.env.CASEKING_SYNC_SECRET;
  try {
    const fresh = await import("../caseking-product-normalization.mjs?nocache=1");
    assert.equal(typeof fresh.buildCaseKingProducts, "function");
  } finally {
    Object.assign(process.env, saved);
  }
});

// ==========================================================================
// 2. Production sync uses THIS module and its guard is untouched
// ==========================================================================

test("sync-caseking.mjs imports normalization from the extracted module", () => {
  const sync = readFileSync(new URL("../sync-caseking.mjs", import.meta.url), "utf8");
  assert.match(sync, /from\s+["']\.\/caseking-product-normalization\.mjs["']/);
  // And no longer defines the logic itself.
  assert.doesNotMatch(sync, /^export function buildCaseKingProducts/m);
  assert.doesNotMatch(sync, /^function normalizeAccessoryBrand/m);
});

test("the production destination guard is byte-unchanged", () => {
  const sync = readFileSync(new URL("../sync-caseking.mjs", import.meta.url), "utf8");
  assert.match(sync, /const OWNED_CASEKING_CONVEX_URL = "https:\/\/elated-butterfly-122\.eu-west-1\.convex\.cloud";/);
  assert.match(sync, /if \(CASEKING_CONVEX_URL !== OWNED_CASEKING_CONVEX_URL\) \{/);
  assert.match(sync, /throw new Error\("CASEKING_CONVEX_URL must point to the owned CaseKing deployment"\);/);
  assert.match(sync, /if \(CLEANUP\) throw new Error\("CLEANUP is disabled for the Koff → CaseKing sync"\);/);
  // The approved operation allow-list must still be the same five.
  assert.match(sync, /"products:backfillMatchKeys"/);
  assert.match(sync, /"products:upsertBatch"/);
  assert.match(sync, /"meta:addBrand"/);
  assert.match(sync, /"meta:addModel"/);
  assert.match(sync, /"meta:countProductsByCategory"/);
});

// ==========================================================================
// 3. Normalization output — every field production sync depends on
// ==========================================================================

// category is a SUPPLIER SERIES name (a CATEGORY_MAP key), not a storefront
// category - "Carbon Silicone" maps to keysove-i-kalufi.
const RAW = {
  sourceId: "KF2367119",
  sourceProductId: 380614,
  name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 4G / Redmi 17 5G - Black",
  description: "Описание от доставчика",
  basePrice: 1.92,
  imageUrl: "https://cdn.koff.ro/img/3/2/9/4/7/8/7/3294787.jpg",
  category: "Carbon Silicone",
};

const built = () => {
  const slug = norm.resolveCategorySlug(RAW);
  return { slug, rows: norm.buildCaseKingProducts(RAW, slug) };
};

test("sourceKey is SKU-based and stable, one row per compatible device", () => {
  const { rows } = built();
  // "Redmi 17 4G / Redmi 17 5G" is two compatible devices => two rows, each
  // carrying the same stable SKU but its own device identity.
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.sourceKey),
    [
      "koff-sync:KF2367119:keysove-i-kalufi:Xiaomi:Redmi 17 4G",
      "koff-sync:KF2367119:keysove-i-kalufi:Xiaomi:Redmi 17 5G",
    ]
  );
  for (const r of rows) assert.match(r.sourceKey, /^koff-sync:KF2367119:keysove-i-kalufi:/);
});

test("sourceProductId is carried through unchanged", () => {
  for (const r of built().rows) assert.equal(r.sourceProductId, 380614);
});

test("the four matchKey inputs are produced", () => {
  const { rows, slug } = built();
  assert.equal(slug, "keysove-i-kalufi");
  for (const r of rows) {
    for (const f of ["name", "brand", "model", "category"]) {
      assert.equal(typeof r[f], "string");
      assert.ok(r[f].length > 0, `${f} must be non-empty`);
    }
    assert.equal(r.brand, "Xiaomi");
    assert.equal(r.category, "keysove-i-kalufi");
  }
  // The device identity differs per row - that is the whole point of the split.
  assert.deepEqual(rows.map((r) => r.model), ["Redmi 17 4G", "Redmi 17 5G"]);
});

test("image and images follow the existing buildKoffImages rules", () => {
  const { rows } = built();
  assert.equal(rows[0].image, "https://cdn.koff.ro/img/3/2/9/4/7/8/7/3294787.jpg");
  // No raw.images => images is omitted entirely (upsertBatch preserves).
  for (const r of rows) assert.equal(r.images, undefined);

  // A confirmed gallery is carried through, deduped, primary first.
  const withGallery = norm.buildCaseKingProducts(
    { ...RAW, images: [RAW.imageUrl, "https://cdn.koff.ro/img/b.jpg", RAW.imageUrl] },
    "keysove-i-kalufi"
  );
  assert.deepEqual(withGallery[0].images, [
    "https://cdn.koff.ro/img/3/2/9/4/7/8/7/3294787.jpg",
    "https://cdn.koff.ro/img/b.jpg",
  ]);
  assert.equal(withGallery[0].image, withGallery[0].images[0]);
});

test("image is omitted when Koff returns no usable cover", () => {
  const noImg = norm.buildCaseKingProducts({ ...RAW, imageUrl: "" }, "keysove-i-kalufi");
  assert.equal(noImg[0].image, undefined);
});

test("priceB2C and priceB2B come from the existing pricing functions, and end in .99", () => {
  const { addVat, calcB2BPrice, calcB2CPrice } = require_pricing();
  const base = addVat(RAW.basePrice);
  const expectedB2C = calcB2CPrice(base);
  const expectedB2B = calcB2BPrice(base);

  for (const r of built().rows) {
    assert.equal(r.priceB2C, expectedB2C);
    assert.equal(r.priceB2B, expectedB2B);
    assert.equal(Math.round(r.priceB2C * 100) % 100, 99, "priceB2C must end in .99");
    assert.equal(Math.round(r.priceB2B * 100) % 100, 99, "priceB2B must end in .99");
  }
});

// Small helper so the pricing import stays lazy and named.
import * as pricing from "../pricing.mjs";
function require_pricing() {
  return pricing;
}

test("sellable filtering is driven solely by a positive numeric stock", () => {
  const rows = norm.buildCaseKingProducts(RAW, "keysove-i-kalufi");
  assert.equal(norm.isSellable(rows[0]), false, "stock omitted => not sellable");
  assert.equal(norm.isSellable({ stock: 0 }), false);
  assert.equal(norm.isSellable({ stock: 3 }), true);
  assert.equal(norm.isSellable({}), false);
  assert.equal(norm.isSellable(null), false);
});

test("deviceLabel rules are unchanged for every branch it special-cases", () => {
  assert.equal(norm.deviceLabel("Apple", "iPhone 16 Pro Max"), "iPhone 16 Pro Max");
  assert.equal(norm.deviceLabel("Samsung", "Galaxy S25 Ultra"), "Samsung Galaxy S25 Ultra");
  assert.equal(norm.deviceLabel("Samsung", "S25 Ultra"), "Samsung Galaxy S25 Ultra");
  assert.equal(norm.deviceLabel("MOTO", "Moto G84"), "Motorola Moto G84");
  assert.equal(norm.deviceLabel("Xiaomi Watch", "Watch9"), "Xiaomi Watch9");
  assert.equal(norm.deviceLabel("Google Watch", "Pixel Watch 5 45mm"), "Google Pixel Watch 5 45mm");
  assert.equal(norm.deviceLabel("Spigen", "Spigen Case"), "Spigen Case");
});

test("an unmapped supplier category resolves to null rather than guessing", () => {
  assert.equal(norm.resolveCategorySlug({ category: "Нещо Непознато", name: "x" }), null);
});

// ==========================================================================
// 4. Determinism — the same input always yields the same bytes
// ==========================================================================

test("normalization is deterministic across repeated calls", () => {
  const a = JSON.stringify(norm.buildCaseKingProducts(RAW, "keysove-i-kalufi"));
  const b = JSON.stringify(norm.buildCaseKingProducts(RAW, "keysove-i-kalufi"));
  assert.equal(createHash("sha256").update(a).digest("hex"),
               createHash("sha256").update(b).digest("hex"));
});
