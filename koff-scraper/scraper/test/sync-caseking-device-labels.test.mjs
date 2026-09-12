import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded to
// only run when the file is executed directly). This file only exercises
// the pure, exported deviceLabel() display-only helper - it makes no
// network calls and never touches stored brand/model/sourceKey (those
// come from bm.brand/bm.model directly in buildCaseKingProducts, never
// from this function's output).
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { deviceLabel, buildCaseKingProducts } = await import("../sync-caseking.mjs");

test("Apple: brand is dropped entirely, model alone is self-identifying", () => {
  assert.equal(deviceLabel("Apple", "iPhone 16 Pro Max"), "iPhone 16 Pro Max");
});

test("Samsung: always shows Galaxy exactly once when model lacks it", () => {
  assert.equal(deviceLabel("Samsung", "S25 Ultra"), "Samsung Galaxy S25 Ultra");
});

test("Samsung: does not duplicate Galaxy when the model already contains it", () => {
  assert.equal(deviceLabel("Samsung", "Galaxy Z Fold8"), "Samsung Galaxy Z Fold8");
  assert.doesNotMatch(deviceLabel("Samsung", "Galaxy Z Fold8"), /Galaxy Galaxy/);
});

test("Motorola: stored brand MOTO displays as the real brand name, no duplicate Moto", () => {
  assert.equal(deviceLabel("MOTO", "G84 5G"), "Motorola Moto G84 5G");
  assert.doesNotMatch(deviceLabel("MOTO", "Moto G84 5G"), /Moto Moto/);
});

test("Samsung Watch + a model with no space before the digit no longer duplicates Watch", () => {
  const label = deviceLabel("Samsung Watch", "Watch9 44mm");
  assert.equal(label, "Samsung Watch9 44mm");
  assert.doesNotMatch(label, /Watch Watch/i);
});

test("Google Watch + a model where Watch is not at the start no longer duplicates Watch", () => {
  const label = deviceLabel("Google Watch", "Pixel Watch 5 45mm");
  assert.equal(label, "Google Pixel Watch 5 45mm");
  assert.doesNotMatch(label, /Watch.*Watch/i);
});

test("Apple Watch (the already-correct case) is unaffected by the fix", () => {
  assert.equal(deviceLabel("Apple Watch", "Watch 12"), "Apple Watch 12");
});

test("Xiaomi Watch with a model that never mentions Watch still gets a natural label", () => {
  assert.equal(deviceLabel("Xiaomi Watch", "S3 46mm"), "Xiaomi Watch S3 46mm");
});

test("other brands are unaffected by this phase's changes (unchanged prior behavior)", () => {
  assert.equal(deviceLabel("Xiaomi", "Redmi Note 15 Pro"), "Xiaomi Redmi Note 15 Pro");
  assert.equal(deviceLabel("UAG", "Monarch"), "UAG Monarch");
});

test("integration: a real Samsung phone case row shows the fixed device label in the generated name", () => {
  const raw = {
    sourceId: "KF9000001", id: 111111,
    name: "Spigen - Liquid Air - Samsung S25 Ultra - Black",
    manufacturer: "Spigen", category: "Liquid Air", basePrice: 5, stock: 5,
  };
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.match(product.name, /Samsung Galaxy S25 Ultra/);
  // stored identity is untouched by the display fix
  assert.equal(product.brand, "Samsung");
  assert.equal(product.model, "S25 Ultra");
  assert.equal(product.sourceKey, "koff-sync:KF9000001:keysove-i-kalufi:Samsung:S25 Ultra");
});

test("integration: a real watch case row no longer shows duplicated 'Watch' text", () => {
  // brand-model.mjs parses "Samsung Watch9 44mm" into brand="Samsung
  // Watch" (remapped, since the segment mentions "watch") and
  // model="Watch9 44mm" - exactly the real shape that used to produce
  // "Samsung Watch Watch9 44mm".
  const raw = {
    sourceId: "KF9000002", id: 222222,
    name: "Spigen - Thin Fit 360 - Samsung Watch9 44mm - Black",
    manufacturer: "Spigen", category: "SmartWatch Cases", basePrice: 5, stock: 5,
  };
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.doesNotMatch(product.name, /Watch Watch/i);
  assert.match(product.name, /Samsung Watch9 44mm/);
});
