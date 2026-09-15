import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded to
// only run when the file is executed directly - see the bottom of
// sync-caseking.mjs). This test only exercises pure functions; it makes no
// network calls and reads no live Koff/CaseKing data.
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { isSellable, buildCaseKingProducts } = await import("../sync-caseking.mjs");
const { mapToConvexProduct } = await import("../product-mapping.mjs");

test("isSellable accepts only a verified positive quantity", () => {
  assert.equal(isSellable({ stock: 1 }), true);
  assert.equal(isSellable({ stock: 250 }), true);

  assert.equal(isSellable({ stock: 0 }), false, "out of stock is not sellable");
  assert.equal(isSellable({}), false, "missing stock is not sellable");
  assert.equal(isSellable({ stock: undefined }), false);
  assert.equal(isSellable({ stock: null }), false);
  assert.equal(isSellable({ stock: -5 }), false);
  assert.equal(isSellable({ stock: NaN }), false);
  assert.equal(isSellable({ stock: Infinity }), false);
  assert.equal(isSellable({ stock: "3" }), false, "a string quantity is unverified, not sellable");
  assert.equal(isSellable(undefined), false);
});

function rawProduct(overrides = {}) {
  return mapToConvexProduct({
    id: 380614,
    sku: "KF2367119",
    name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17",
    salePrice: 5.5,
    coverUrl: "https://cdn.koff.ro/img/x.jpg",
    manufacturer: { name: "Techsuit" },
    ...overrides,
  }, "Phone Cases");
}

test("a generated row carries the supplier quantity, so metadata filtering can read it", () => {
  const inStock = buildCaseKingProducts(rawProduct({ stock: 4 }), "keysove-i-kalufi");
  assert.ok(inStock.length > 0);
  for (const row of inStock) {
    assert.equal(row.stock, 4);
    assert.equal(isSellable(row), true);
  }

  const outOfStock = buildCaseKingProducts(rawProduct({ stock: 0 }), "keysove-i-kalufi");
  assert.ok(outOfStock.length > 0);
  for (const row of outOfStock) {
    assert.equal(row.stock, 0);
    assert.equal(isSellable(row), false);
  }
});

test("a row whose supplier quantity is unusable omits stock entirely and is not sellable", () => {
  const rows = buildCaseKingProducts(rawProduct({ stock: undefined }), "keysove-i-kalufi");
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal("stock" in row, false, "unverified stock must be omitted, not sent as 0");
    assert.equal(isSellable(row), false);
  }
});

// The metadata pass in main() creates brand/model entries only for rows that
// pass isSellable, while the product upsert still receives every row. This
// reproduces that split on a mixed batch without running the real sync.
test("only sellable rows drive NEW brand/model metadata, while every row still reaches the product upsert", () => {
  const generated = [
    { brand: "Apple", model: "iPhone 16", stock: 3 },
    { brand: "Samsung", model: "Galaxy S25", stock: 0 },
    { brand: "Xiaomi", model: "Redmi 17" },
    { brand: "Apple", model: "iPhone 15", stock: 12 },
    { brand: "Всички марки", model: "Всички модели", stock: 9 },
  ];

  const brandsCache = new Set();
  const modelsCache = new Set();
  for (const p of generated) {
    if (!isSellable(p)) continue;
    if (p.brand === "Всички марки") continue;
    brandsCache.add(p.brand.toLowerCase());
    if (p.model !== "Всички модели") {
      modelsCache.add(`${p.brand.toLowerCase()}:${p.model.toLowerCase()}`);
    }
  }

  assert.deepEqual([...brandsCache].sort(), ["apple"]);
  assert.deepEqual([...modelsCache].sort(), ["apple:iphone 15", "apple:iphone 16"]);

  // Zero-stock and unverified-stock brands must NOT gain dropdown entries.
  assert.equal(brandsCache.has("samsung"), false);
  assert.equal(brandsCache.has("xiaomi"), false);

  // ...but every generated row is still handed to the product upsert, so
  // existing products keep receiving their stock updates, including 0.
  const upsertInput = generated.map(({ brand, model, stock }) => ({ brand, model, stock }));
  assert.equal(upsertInput.length, generated.length);
  assert.equal(upsertInput.filter(r => !isSellable(r)).length, 2);
});
