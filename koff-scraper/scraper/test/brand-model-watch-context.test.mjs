import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrandModelsFromFullSegment } from "../brand-model.mjs";

const identities = (input) => extractBrandModelsFromFullSegment(input)
  .map(({ brand, model }) => `${brand}:${model}`);

test("Apple Watch Ultra slash generations inherit Ultra rather than Watch", () => {
  assert.deepEqual(
    identities("Apple Watch 8/9/10/11/SE/SE 2/SE 3/Ultra/2/3/4"),
    [
      "Apple Watch:Watch 8",
      "Apple Watch:Watch 9",
      "Apple Watch:Watch 10",
      "Apple Watch:Watch 11",
      "Apple Watch:SE",
      "Apple Watch:SE 2",
      "Apple Watch:SE 3",
      "Apple Watch:Ultra",
      "Apple Watch:Ultra 2",
      "Apple Watch:Ultra 3",
      "Apple Watch:Ultra 4",
    ],
  );
});

test("Huawei Watch Fit slash continuations retain the Watch Fit identity", () => {
  assert.deepEqual(
    identities("Huawei Watch Fit 5 Pro / Fit 5 / Fit 4 Pro / Fit 4 / Fit 3"),
    [
      "Huawei Watch:Watch Fit 5 Pro",
      "Huawei Watch:Watch Fit 5",
      "Huawei Watch:Watch Fit 4 Pro",
      "Huawei Watch:Watch Fit 4",
      "Huawei Watch:Watch Fit 3",
    ],
  );
});

test("ordinary slash-separated phone models keep their existing behavior", () => {
  assert.deepEqual(
    identities("Xiaomi Redmi 17 4G / Redmi 17 5G"),
    ["Xiaomi:Redmi 17 4G", "Xiaomi:Redmi 17 5G"],
  );
});

test("existing Samsung, Xiaomi, Google and Honor watch roots remain stable", () => {
  // "Watch4" (no space) now canonicalizes to "Watch 4" - see
  // brand-model-corrupted-continuation.test.mjs for the full regression
  // coverage of this fix (real raw catalog data mixes "Watch4"/"Watch 4"
  // for the same device, which had created two separate catalog models).
  assert.deepEqual(identities("Samsung Galaxy Watch4/5/6"), [
    "Samsung Watch:Watch 4",
    "Samsung Watch:Watch 5",
    "Samsung Watch:Watch 6",
  ]);
  assert.deepEqual(identities("Xiaomi Watch 2/3"), [
    "Xiaomi Watch:Watch 2",
    "Xiaomi Watch:Watch 3",
  ]);
  assert.deepEqual(identities("Google Pixel Watch 2/3"), [
    "Google Watch:Pixel Watch 2",
    "Google Watch:Pixel Watch 3",
  ]);
  assert.deepEqual(identities("Honor Watch 4/5"), [
    "Honor Watch:Watch 4",
    "Honor Watch:Watch 5",
  ]);
});
