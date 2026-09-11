import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded to
// only run when the file is executed directly - see the bottom of
// sync-caseking.mjs). This test only exercises the pure product-building
// function; it makes no network calls and reads no live Koff/CaseKing data.
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { buildCaseKingProducts } = await import("../sync-caseking.mjs");
const { mapToConvexProduct } = await import("../product-mapping.mjs");

test("a raw Koff product's sourceProductId survives into the CaseKing sync payload alongside its independent SKU-based sourceId/sourceKey", () => {
  const raw = mapToConvexProduct({
    id: 380614,
    sku: "KF2367119",
    name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17",
    salePrice: 5.5,
    coverUrl: "https://cdn.koff.ro/img/x.jpg",
    manufacturer: { name: "Techsuit" },
  }, "Phone Cases");

  assert.equal(raw.sourceId, "KF2367119");
  assert.equal(raw.sourceProductId, 380614);

  const [product] = buildCaseKingProducts(raw, "vanshni-baterii");
  assert.equal(product.sourceProductId, 380614);
  assert.equal(product.sourceKey, `koff-sync:KF2367119:vanshni-baterii:Techsuit:all`);
  assert.equal(product.source, "koff-sync");
});

test("sourceProductId is omitted from the sync payload when the raw product never had a valid numeric id", () => {
  const raw = mapToConvexProduct({
    id: undefined,
    sku: "KF9999999",
    name: "Weird product with no numeric id",
    salePrice: 5.5,
    manufacturer: { name: "Techsuit" },
  }, "Phone Cases");

  assert.equal("sourceProductId" in raw, false);

  const [product] = buildCaseKingProducts(raw, "vanshni-baterii");
  assert.equal("sourceProductId" in product, false);
});
