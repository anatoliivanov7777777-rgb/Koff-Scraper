// End-to-end coverage of the full image pipeline this task adds to:
// raw Koff product -> mapToConvexProduct(raw, category, gallery) ->
// buildKoffImages(mapped) -> { image, images } as sent to CaseKing.
// Maps directly to the Step 7 checklist in the task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapToConvexProduct } from "../product-mapping.mjs";
import { buildKoffImages } from "../image-urls.mjs";

const RAW = { id: 1, sku: "KF1", name: "Product", salePrice: 5, coverUrl: "https://cdn.koff.ro/cover.jpg" };
const pipeline = (raw, gallery) => buildKoffImages(mapToConvexProduct(raw, "Cat", gallery));

test("1. cover only (no gallery argument) -> single image", () => {
  assert.deepEqual(pipeline(RAW, undefined), ["https://cdn.koff.ro/cover.jpg"]);
});

test("2. cover + 2 gallery images -> all three, cover first", () => {
  assert.deepEqual(
    pipeline(RAW, ["https://cdn.koff.ro/g1.jpg", "https://cdn.koff.ro/g2.jpg"]),
    ["https://cdn.koff.ro/cover.jpg", "https://cdn.koff.ro/g1.jpg", "https://cdn.koff.ro/g2.jpg"]
  );
});

test("3. gallery repeats the cover -> cover kept once, still first", () => {
  assert.deepEqual(
    pipeline(RAW, ["https://cdn.koff.ro/cover.jpg", "https://cdn.koff.ro/g1.jpg"]),
    ["https://cdn.koff.ro/cover.jpg", "https://cdn.koff.ro/g1.jpg"]
  );
});

test("4. duplicated gallery image -> deduplicated once", () => {
  assert.deepEqual(
    pipeline(RAW, ["https://cdn.koff.ro/g1.jpg", "https://cdn.koff.ro/g1.jpg"]),
    ["https://cdn.koff.ro/cover.jpg", "https://cdn.koff.ro/g1.jpg"]
  );
});

test("5. invalid URL in gallery -> dropped, valid ones kept", () => {
  assert.deepEqual(
    pipeline(RAW, ["not a url", "https://cdn.koff.ro/g1.jpg"]),
    ["https://cdn.koff.ro/cover.jpg", "https://cdn.koff.ro/g1.jpg"]
  );
});

test("6. http:// gallery URL rejected", () => {
  assert.deepEqual(
    pipeline(RAW, ["http://cdn.koff.ro/insecure.jpg", "https://cdn.koff.ro/g1.jpg"]),
    ["https://cdn.koff.ro/cover.jpg", "https://cdn.koff.ro/g1.jpg"]
  );
});

test("7. malformed gallery response (not an array) -> no images field, cover still present", () => {
  const mapped = mapToConvexProduct(RAW, "Cat", "totally-malformed");
  assert.equal("images" in mapped, false);
  assert.deepEqual(buildKoffImages(mapped), ["https://cdn.koff.ro/cover.jpg"]);
});

test("8. detail request failure (represented as an empty gallery array) -> falls back to cover only", () => {
  assert.deepEqual(pipeline(RAW, []), ["https://cdn.koff.ro/cover.jpg"]);
});

test("9 & 10. deterministic order, cover always first, regardless of gallery ordering", () => {
  const g = ["https://cdn.koff.ro/z.jpg", "https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/m.jpg"];
  const result = pipeline(RAW, g);
  assert.equal(result[0], "https://cdn.koff.ro/cover.jpg");
  assert.deepEqual(result.slice(1), g);
  // Running it again must produce the exact same order (no Set/Map iteration surprises).
  assert.deepEqual(pipeline(RAW, g), result);
});

test("11. empty gallery does not destroy an existing single image (no images key sent at all)", () => {
  const mapped = mapToConvexProduct(RAW, "Cat", []);
  assert.equal("images" in mapped, false);
  assert.equal(mapped.imageUrl, "https://cdn.koff.ro/cover.jpg");
});

test("12. normal single-image behavior is unchanged when the gallery feature is not used", () => {
  const withoutFeature = buildKoffImages(mapToConvexProduct(RAW, "Cat"));
  assert.deepEqual(withoutFeature, ["https://cdn.koff.ro/cover.jpg"]);
});

test("13. one product's failed gallery lookup does not affect another product's mapping", () => {
  const productA = mapToConvexProduct({ ...RAW, id: 1, sku: "A" }, "Cat", []); // failed lookup -> []
  const productB = mapToConvexProduct({ ...RAW, id: 2, sku: "B", coverUrl: "https://cdn.koff.ro/coverB.jpg" }, "Cat", ["https://cdn.koff.ro/gB.jpg"]);
  assert.deepEqual(buildKoffImages(productA), ["https://cdn.koff.ro/cover.jpg"]);
  assert.deepEqual(buildKoffImages(productB), ["https://cdn.koff.ro/coverB.jpg", "https://cdn.koff.ro/gB.jpg"]);
});
