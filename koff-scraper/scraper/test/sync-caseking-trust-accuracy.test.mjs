import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded to
// only run when the file is executed directly - see the bottom of
// sync-caseking.mjs). This test only exercises the pure product-building
// function; it makes no network calls and reads no live Koff/CaseKing data.
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { buildCaseKingProducts } = await import("../sync-caseking.mjs");

function baseRaw(overrides = {}) {
  return {
    sourceId: "KF1000001",
    id: 380614,
    name: "Spigen - Liquid Air - iPhone 16 - Black",
    manufacturer: "Spigen",
    basePrice: 5,
    stock: 10,
    ...overrides,
  };
}

test("product with no description gets description === \"\"", () => {
  const raw = baseRaw({ description: undefined });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.description, "");
});

test("product with an empty/whitespace-only description also gets description === \"\"", () => {
  const raw = baseRaw({ description: "   " });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.description, "");
});

test("product with a real supplier description preserves it, trimmed", () => {
  const raw = baseRaw({ description: "  Real supplier-provided description.  " });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.description, "Real supplier-provided description.");
});

test("specs.material is empty (unknown), not a fabricated default", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.specs.material, "");
});

test("specs.weight is empty (unknown), not a fabricated default", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.specs.weight, "");
});

test("specs.origin is empty (unknown), not a fabricated default", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.specs.origin, "");
});

test("specs.delivery is empty (unknown), not a fabricated default", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.specs.delivery, "");
});

test("no generated \"Премиум\"/\"най-висок клас\" fallback text remains anywhere in the output, with or without a supplier description", () => {
  const withDescription = buildCaseKingProducts(
    baseRaw({ description: "Real description" }),
    "keysove-i-kalufi"
  );
  const withoutDescription = buildCaseKingProducts(baseRaw({ description: "" }), "keysove-i-kalufi");

  for (const [product] of [withDescription, withoutDescription]) {
    assert.doesNotMatch(product.description, /Премиум/);
    assert.doesNotMatch(product.description, /най-висок клас/);
    assert.doesNotMatch(product.specs.material, /Премиум/);
    assert.doesNotMatch(product.name, /Премиум/);
  }
});

test("sourceKey is unchanged by the trust-accuracy fix", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.sourceKey, "koff-sync:KF1000001:keysove-i-kalufi:Apple:iPhone 16");
});

test("sourceProductId is unchanged by the trust-accuracy fix", () => {
  const raw = baseRaw({ sourceProductId: 380614 });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.sourceProductId, 380614);
});

test("pricing is unchanged by the trust-accuracy fix", () => {
  const raw = baseRaw({ basePrice: 5 });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(typeof product.priceB2C, "number");
  assert.equal(typeof product.priceB2B, "number");
  assert.ok(product.priceB2C > 0);
  assert.ok(product.priceB2B > 0);
});

test("image behavior is unchanged: no image/images key at all when Koff returns none", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal("image" in product, false);
  assert.equal("images" in product, false);
});

test("category/brand/model behavior is unchanged", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.category, "keysove-i-kalufi");
  assert.equal(product.brand, "Apple");
  assert.equal(product.model, "iPhone 16");
});

test("rating still defaults to 5 - untouched internal compatibility field, not customer-facing (public DTO no longer exposes it)", () => {
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.rating, 5);
});
