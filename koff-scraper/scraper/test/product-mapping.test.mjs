import { test } from "node:test";
import assert from "node:assert/strict";
import { mapToConvexProduct, toSourceProductId } from "../product-mapping.mjs";

test("toSourceProductId accepts only finite positive integers", () => {
  assert.equal(toSourceProductId(380614), 380614);
  assert.equal(toSourceProductId("380614"), 380614);
  assert.equal(toSourceProductId(0), undefined);
  assert.equal(toSourceProductId(-1), undefined);
  assert.equal(toSourceProductId(1.5), undefined);
  assert.equal(toSourceProductId(NaN), undefined);
  assert.equal(toSourceProductId(undefined), undefined);
  assert.equal(toSourceProductId(null), undefined);
});

test("raw.id and raw.sku map to two independent identities: sourceId stays SKU-based, sourceProductId is the numeric Koff id", () => {
  const raw = {
    id: 380614,
    sku: "KF2367119",
    name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17",
    salePrice: 5.5,
    coverUrl: "https://cdn.koff.ro/img/x.jpg",
    manufacturer: { name: "Techsuit" },
  };
  const mapped = mapToConvexProduct(raw, "Phone Cases");
  assert.equal(mapped.sourceId, "KF2367119");
  assert.equal(mapped.sourceProductId, 380614);
});

test("sourceId falls back to raw.id when no SKU, but sourceProductId is still the same raw.id independently", () => {
  const raw = { id: 380614, sku: null, name: "No SKU product", salePrice: 5.5 };
  const mapped = mapToConvexProduct(raw, "Phone Cases");
  assert.equal(mapped.sourceId, "380614");
  assert.equal(mapped.sourceProductId, 380614);
});

test("sourceProductId is omitted (not set to a falsy/invalid value) when raw.id is missing or invalid", () => {
  const raw = { id: undefined, sku: "KF1", name: "Weird product", salePrice: 5.5 };
  const mapped = mapToConvexProduct(raw, "Phone Cases");
  assert.equal(mapped.sourceId, "KF1");
  assert.equal("sourceProductId" in mapped, false);
});

test("supplier max and isEol availability fields are preserved losslessly without filtering", () => {
  const sellable = mapToConvexProduct({
    id: 371914,
    sku: "KF2365668",
    name: "Available product",
    salePrice: 3.9,
    max: 27,
    isEol: false,
  }, "Camera Glass");
  assert.equal(sellable.max, 27);
  assert.equal(sellable.isEol, false);
  assert.equal(sellable.stock, 27);

  const eol = mapToConvexProduct({
    id: 371915,
    sku: "KF2365669",
    name: "EOL product",
    salePrice: 3.9,
    max: 0,
    isEol: true,
  }, "Camera Glass");
  assert.equal(eol.max, 0);
  assert.equal(eol.isEol, true);
  assert.equal(eol.stock, 0);

  const temporarilyOutOfStock = mapToConvexProduct({
    id: 371917,
    sku: "KF2365671",
    name: "Temporarily unavailable product",
    salePrice: 3.9,
    max: 0,
    isEol: false,
  }, "Camera Glass");
  assert.equal(temporarilyOutOfStock.max, 0);
  assert.equal(temporarilyOutOfStock.isEol, false);
  assert.equal(temporarilyOutOfStock.stock, 0);
});

test("missing supplier availability fields remain missing instead of being guessed", () => {
  const mapped = mapToConvexProduct({
    id: 371916,
    sku: "KF2365670",
    name: "Unknown availability",
    salePrice: 3.9,
  }, "Camera Glass");
  assert.equal("max" in mapped, false);
  assert.equal("isEol" in mapped, false);
  assert.equal("stock" in mapped, false);
});
