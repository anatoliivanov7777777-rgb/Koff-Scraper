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
