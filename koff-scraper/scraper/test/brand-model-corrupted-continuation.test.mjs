import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrandModelsFromFullSegment } from "../brand-model.mjs";

// Regression fixtures for the model-catalog data-quality audit (2026-09-14):
// real Koff raw supplier titles produced malformed catalog models -
//   Apple: "Phone 17 Pro" / "Phone 17" / "Phone 16 Pro" (missing "i")
//   Samsung Watch: "Watch4" vs "Watch 4" (inconsistent raw spacing)
// Every fixture string here is verbatim (minus the supplier/SKU prefix,
// which extractBrandModelsFromFullSegment never receives) from the real
// raw catalog rows that caused the defect.

const identities = (input) => extractBrandModelsFromFullSegment(input)
  .map(({ brand, model }) => `${brand}:${model}`);

// --- 1. the exact real defect string is fixed ---

test("1. the real defect slash-group produces four correct iPhone models, never 'Phone <n>'", () => {
  // Verbatim device-compatibility segment from the real raw titles:
  // "3mk - HardGlass Screen Protector - iPhone 18 Pro / Phone 17 Pro /
  //  Phone 17 / Phone 16 Pro - Clear" and two Spigen titles with the
  // identical segment.
  assert.deepEqual(
    identities("iPhone 18 Pro / Phone 17 Pro / Phone 17 / Phone 16 Pro"),
    [
      "Apple:iPhone 18 Pro",
      "Apple:iPhone 17 Pro",
      "Apple:iPhone 17",
      "Apple:iPhone 16 Pro",
    ],
  );
});

// --- 2. no generated Apple canonical model starts with "Phone <number>" ---

test("2. no generated Apple model ever starts with 'Phone <digit>' for any real defect variant", () => {
  const fixtures = [
    "iPhone 18 Pro / Phone 17 Pro / Phone 17 / Phone 16 Pro",
    "iPhone 15 / Phone 15 Pro / Phone 15 Pro Max",
    "iPhone 14 Pro Max / Phone 14",
  ];
  for (const fixture of fixtures) {
    const models = extractBrandModelsFromFullSegment(fixture)
      .filter((r) => r.brand === "Apple")
      .map((r) => r.model);
    assert.ok(models.length > 0, `expected at least one Apple model from: ${fixture}`);
    for (const m of models) {
      assert.doesNotMatch(m, /^Phone\s+\d/i, `model "${m}" from "${fixture}" must not start with "Phone <digit>"`);
    }
  }
});

// --- 3. existing legitimate Apple/iPhone parsing is unchanged ---

test("3a. iPhone 14 Pro/Max still expands to Pro and Pro Max (unchanged pre-existing behavior)", () => {
  assert.deepEqual(
    identities("iPhone 14 Pro/Max"),
    ["Apple:iPhone 14 Pro", "Apple:iPhone 14 Pro Max"],
  );
});

test("3b. iPhone 6/6s still expands correctly (unchanged pre-existing behavior)", () => {
  assert.deepEqual(
    identities("iPhone 6/6s"),
    ["Apple:iPhone 6", "Apple:iPhone 6s"],
  );
});

test("3c. a plain single iPhone model is unaffected", () => {
  assert.deepEqual(identities("iPhone 15 Plus"), ["Apple:iPhone 15 Plus"]);
});

test("3d. Apple Watch slash generations still work unchanged (Ultra inheritance untouched)", () => {
  assert.deepEqual(
    identities("Apple Watch 9/10/Ultra/2"),
    ["Apple Watch:Watch 9", "Apple Watch:Watch 10", "Apple Watch:Ultra", "Apple Watch:Ultra 2"],
  );
});

// --- 4. "Phone" text outside an established Apple iPhone continuation is never rewritten ---

test("4a. a genuinely unrelated 'Phone' brand/model is never touched (no Apple root established)", () => {
  assert.deepEqual(identities("ROG Phone 8"), ["Asus:ROG Phone 8"]);
});

test("4b. 'Phone <n>' appearing without any preceding iPhone root is left completely alone", () => {
  // No Apple context has been established at all in this slash-group -
  // the rule must never fire here.
  const result = extractBrandModelsFromFullSegment("Phone 17 Pro");
  assert.equal(result.length, 1);
  assert.notEqual(result[0].brand, "Apple");
});

test("4c. a 'Phone' continuation after a NON-Apple root is not rewritten", () => {
  // Establishes a Samsung root first - the Apple-only rule must not leak
  // across brands.
  const result = extractBrandModelsFromFullSegment("Samsung Galaxy A54 / Speakerphone accessory");
  assert.deepEqual(
    result.map((r) => `${r.brand}:${r.model}`),
    ["Samsung:A54", "Samsung:Speakerphone accessory"],
  );
});

test("4d. 'Phone' as a continuation is untouched even when it doesn't match the exact 'Phone <digit>' shape", () => {
  // Establishes iPhone root, but this continuation fragment doesn't match
  // the specific defect shape (no digit right after "Phone") - must fall
  // through unchanged rather than being guessed at.
  const result = extractBrandModelsFromFullSegment("iPhone 15 / Phone Case Accessory");
  assert.deepEqual(
    result.map((r) => `${r.brand}:${r.model}`),
    ["Apple:iPhone 15", "Apple:Phone Case Accessory"],
  );
});

// --- 5. Samsung Watch4/Watch 4 canonicalization ---

test("5a. real raw no-space 'Watch4' canonicalizes to 'Watch 4'", () => {
  assert.deepEqual(identities("Samsung Galaxy Watch4"), ["Samsung Watch:Watch 4"]);
});

test("5b. real raw already-spaced 'Watch 4' stays 'Watch 4' (idempotent, same canonical form)", () => {
  assert.deepEqual(identities("Samsung Galaxy Watch 4"), ["Samsung Watch:Watch 4"]);
});

test("5c. future-style suffixed variant 'Watch4 Classic' canonicalizes to 'Watch 4 Classic'", () => {
  const result = extractBrandModelsFromFullSegment("Samsung Galaxy Watch4 Classic 46mm");
  assert.equal(result.length, 1);
  assert.equal(result[0].brand, "Samsung Watch");
  assert.equal(result[0].model, "Watch 4 Classic 46mm");
});

test("5d. a real multi-device raw title normalizes Watch4 while leaving the other generations exactly as parsed", () => {
  // Verbatim shape from real raw rows like "Techsuit - Watchband 20mm
  // (W084) - Samsung Galaxy Watch4/5/Active 2, ...".
  assert.deepEqual(
    identities("Samsung Galaxy Watch4/5/Active 2"),
    ["Samsung Watch:Watch 4", "Samsung Watch:Watch 5", "Samsung Watch:Active 2"],
  );
});

test("5e. other Watch generations are deliberately left untouched (their own raw-data majority is inconsistent, e.g. 7/8 are majority no-space)", () => {
  assert.deepEqual(identities("Samsung Galaxy Watch7"), ["Samsung Watch:Watch7"]);
  assert.deepEqual(identities("Samsung Galaxy Watch8"), ["Samsung Watch:Watch8"]);
  assert.deepEqual(identities("Samsung Galaxy Watch 6"), ["Samsung Watch:Watch 6"]);
});

test("5f. the Watch4 canonicalization never fires for non-Samsung-Watch brands", () => {
  // A hypothetical "Watch4"-shaped token for a different watch brand must
  // not be silently rewritten by a rule scoped to Samsung Watch only.
  assert.deepEqual(identities("Huawei Watch4"), ["Huawei Watch:Watch4"]);
});

test("5g. Watch4 canonicalization does not corrupt an unrelated larger number (word-boundary safety)", () => {
  // "Watch45" is not "Watch4" + something - \b must prevent a false match.
  assert.deepEqual(identities("Samsung Galaxy Watch45"), ["Samsung Watch:Watch45"]);
});

// --- 6. existing 4G/5G variants remain distinct ---

test("6a. 4G/5G phone variants are never collapsed into one model", () => {
  assert.deepEqual(
    identities("Moto G31 / G31 4G"),
    ["MOTO:Moto G31", "MOTO:G31 4G"],
  );
});

test("6b. a bare '5G' suffix continuation still produces its own distinct model", () => {
  const result = extractBrandModelsFromFullSegment("Redmi Note 13 Pro/5G");
  assert.equal(result.length, 2);
  assert.notDeepEqual(result[0].model, result[1].model);
});

// --- 7. existing Galaxy/Samsung variants are not broadly rewritten ---

test("7a. 'Samsung Galaxy S25' is parsed exactly as before - Samsung/Galaxy tokens untouched", () => {
  assert.deepEqual(identities("Samsung Galaxy S25 Ultra"), ["Samsung:S25 Ultra"]);
});

test("7b. bare 'Galaxy' prefix (no explicit 'Samsung') still resolves to brand Samsung unchanged", () => {
  assert.deepEqual(identities("Galaxy S24"), ["Samsung:S24"]);
});

test("7c. Samsung phone models are unaffected by the Watch4 canonicalization (different brand bucket, non-watch)", () => {
  assert.deepEqual(identities("Samsung Galaxy A04s"), ["Samsung:A04s"]);
});
