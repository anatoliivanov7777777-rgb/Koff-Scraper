import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded to
// only run when the file is executed directly). This file only exercises
// the pure product-building function; it makes no network calls and reads
// no live Koff/CaseKing data.
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { buildCaseKingProducts } = await import("../sync-caseking.mjs");

function rawPhoneCase(overrides = {}) {
  return {
    sourceId: "KF1000001",
    id: 380614,
    name: "Techsuit - CamShield Pro - iPhone 16 Pro Max - Black",
    manufacturer: "Techsuit",
    basePrice: 5,
    stock: 10,
    ...overrides,
  };
}

function rawAccessory(overrides = {}) {
  return {
    sourceId: "KF2367119",
    id: 380620,
    name: "Techsuit - Powerbank Line - Black",
    manufacturer: "Techsuit",
    basePrice: 8,
    stock: 5,
    ...overrides,
  };
}

test("Techsuit phone case: publicMaker=CaseKing, brand/model stay the compatible device, sourceKey stays device-brand/model identity", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.equal(product.publicMaker, "CaseKing");
  assert.equal(product.brand, "Apple");
  assert.equal(product.model, "iPhone 16 Pro Max");
  assert.equal(product.sourceKey, "koff-sync:KF1000001:keysove-i-kalufi:Apple:iPhone 16 Pro Max");
});

test("Techsuit accessory: publicMaker=CaseKing, public brand=CaseKing, sourceKey still contains the original Techsuit identity", () => {
  const [product] = buildCaseKingProducts(rawAccessory(), "vanshni-baterii");
  assert.equal(product.publicMaker, "CaseKing");
  assert.equal(product.brand, "CaseKing");
  assert.equal(product.sourceKey, "koff-sync:KF2367119:vanshni-baterii:Techsuit:all");
});

test("repeated generation of the same Techsuit accessory yields an identical sourceKey (idempotent identity)", () => {
  const [first] = buildCaseKingProducts(rawAccessory(), "vanshni-baterii");
  const [second] = buildCaseKingProducts(rawAccessory(), "vanshni-baterii");
  assert.equal(first.sourceKey, second.sourceKey);
  assert.equal(first.sourceKey, "koff-sync:KF2367119:vanshni-baterii:Techsuit:all");
});

test("non-Techsuit accessory: publicMaker and brand remain the same normalized manufacturer", () => {
  const raw = rawAccessory({ manufacturer: "mcdodo", name: "Mcdodo - Powerbank Line - Black" });
  const [product] = buildCaseKingProducts(raw, "vanshni-baterii");
  assert.equal(product.publicMaker, "Mcdodo");
  assert.equal(product.brand, "Mcdodo");
  assert.equal(product.sourceKey, "koff-sync:KF2367119:vanshni-baterii:Mcdodo:all");
});

test("sourceProductId is unchanged for a Techsuit item", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase({ sourceProductId: 380614 }), "keysove-i-kalufi");
  assert.equal(product.sourceProductId, 380614);
});

test("pricing is unchanged for a Techsuit item", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase({ basePrice: 5 }), "keysove-i-kalufi");
  assert.equal(typeof product.priceB2C, "number");
  assert.equal(typeof product.priceB2B, "number");
  assert.ok(product.priceB2C > 0);
});

test("image behavior is unchanged for a Techsuit item (omitted when Koff returns none)", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.equal("image" in product, false);
  assert.equal("images" in product, false);
});

test("name is now the naming engine's deterministic Bulgarian SEO output (Phase D), using the resolved public maker", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.match(product.name, /^Калъф CaseKing CamShield Pro за/);
  assert.doesNotMatch(product.name, /^Techsuit/);
});

test("naming-engine.mjs IS now imported/wired into sync-caseking.mjs (Phase D)", () => {
  const source = readFileSync(new URL("../sync-caseking.mjs", import.meta.url), "utf8");
  assert.match(source, /from\s+["']\.\/naming-engine\.mjs["']/);
  assert.match(source, /generateProductName\(/);
});

test("no blind global Techsuit string replace exists in sync-caseking.mjs", () => {
  const source = readFileSync(new URL("../sync-caseking.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /replace\([^)]*Techsuit/i);
  assert.doesNotMatch(source, /replaceAll\([^)]*Techsuit/i);
});

test("publicMaker is omitted when no maker can be safely determined for a phone-category product", () => {
  const raw = rawPhoneCase({ manufacturer: undefined, name: "Generic - Universal Case - iPhone 16 - Black" });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal("publicMaker" in product, false);
});

test("publicMaker is omitted when no maker can be safely determined for an accessory-category product", () => {
  const raw = rawAccessory({ manufacturer: undefined, name: "Generic - Universal Cable - Black" });
  const [product] = buildCaseKingProducts(raw, "vanshni-baterii");
  assert.equal("publicMaker" in product, false);
  assert.equal(product.brand, "Всички марки");
});

test("existing trust-accuracy behavior is preserved: empty fabricated specs, no promotional description fallback", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase({ description: undefined }), "keysove-i-kalufi");
  assert.equal(product.specs.material, "");
  assert.equal(product.specs.weight, "");
  assert.equal(product.specs.origin, "");
  assert.equal(product.specs.delivery, "");
  assert.equal(product.description, "");
  assert.doesNotMatch(product.name, /Премиум/);
});

test("a non-Techsuit phone-case manufacturer is unaffected by the rebrand rule", () => {
  const raw = rawPhoneCase({ manufacturer: "Spigen", name: "Spigen - Liquid Air - iPhone 16 - Black" });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.publicMaker, "Spigen");
  assert.equal(product.brand, "Apple");
});
