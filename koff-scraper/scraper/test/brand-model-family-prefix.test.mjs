import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrandModelsFromFullSegment, canonicalizeFamilyModel } from "../brand-model.mjs";

// The live model list (2026-10-10) carried one phone under two names because
// Koff drops the family after the first device of a slash list:
// "G77" beside "Moto G77", "Note 15 4G" beside "Redmi Note 15 4G",
// "A1 Plus" beside "Redmi A1", "Edge 60" beside "Moto Edge 60".

const identities = (input) => extractBrandModelsFromFullSegment(input)
  .map(({ brand, model }) => `${brand}:${model}`);

test("Moto G/E continuation keeps the Moto family", () => {
  assert.deepEqual(identities("Motorola Moto G77 / G67"), ["MOTO:Moto G77", "MOTO:Moto G67"]);
  assert.deepEqual(identities("Motorola Moto G86 Power / G56"), ["MOTO:Moto G86 Power", "MOTO:Moto G56"]);
  assert.deepEqual(identities("Motorola Moto E30 / E40"), ["MOTO:Moto E30", "MOTO:Moto E40"]);
});

test("a Motorola title without Moto gets the same name as one with it", () => {
  assert.deepEqual(identities("Motorola G77"), identities("Motorola Moto G77"));
});

test("Motorola Edge is spelled without Moto, as most Edge rows already are", () => {
  assert.deepEqual(identities("Motorola Moto Edge 60 / Edge 60 Pro"), ["MOTO:Edge 60", "MOTO:Edge 60 Pro"]);
});

test("Redmi Note, Redmi A and Poco continuations keep their family", () => {
  assert.deepEqual(identities("Xiaomi Redmi Note 15 4G / Note 15 Pro"), ["Xiaomi:Redmi Note 15 4G", "Xiaomi:Redmi Note 15 Pro"]);
  assert.deepEqual(identities("Xiaomi Redmi A1 / A1 Plus"), ["Xiaomi:Redmi A1", "Xiaomi:Redmi A1 Plus"]);
  assert.deepEqual(identities("Xiaomi Poco X7 / X7 Pro"), ["Xiaomi:Poco X7", "Xiaomi:Poco X7 Pro"]);
});

test("Xiaomi flagship numbers and other lines are left alone", () => {
  assert.deepEqual(identities("Xiaomi 13 / 13 Pro"), ["Xiaomi:13", "Xiaomi:13 Pro"]);
  assert.deepEqual(identities("Xiaomi Redmi 13 / 13C"), ["Xiaomi:Redmi 13", "Xiaomi:Redmi 13C"]);
  assert.deepEqual(identities("Motorola Razr 50 / Razr 50 Ultra"), ["MOTO:Razr 50", "MOTO:Razr 50 Ultra"]);
  assert.deepEqual(identities("Samsung Galaxy A55 / A35"), ["Samsung:A55", "Samsung:A35"]);
});

test("canonicalizeFamilyModel is idempotent and brand-scoped", () => {
  for (const [brand, model] of [["MOTO", "Moto G77"], ["MOTO", "Edge 60"], ["Xiaomi", "Redmi Note 15 Pro"], ["Xiaomi", "Poco F7"]]) {
    assert.equal(canonicalizeFamilyModel(brand, model), model);
  }
  assert.equal(canonicalizeFamilyModel("Samsung", "Note 20"), "Note 20");
  assert.equal(canonicalizeFamilyModel("Honor", "X7b"), "X7b");
});

// A corrected display name must never become a new product: the sync finds
// existing rows by sourceKey, and a changed key would create a duplicate and
// zero the stock of the original.

test("sourceKey keeps the spelling the product was created with", async () => {
  // Importing must not start a sync (main() is guarded); the module checks the URL.
  process.env.CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";
  const { buildCaseKingProducts } = await import("../sync-caseking.mjs");
  const raw = {
    id: 990001,
    name: "Spigen - Liquid Air - Motorola Moto G77 / G67 - Black",
    manufacturer: "Spigen",
    basePrice: 5,
    stock: 10,
    imageUrl: "https://cdn.koff.ro/img/cover.jpg",
  };
  const products = buildCaseKingProducts(raw, "keysove-i-kalufi");
  const byModel = Object.fromEntries(products.map((p) => [p.model, p.sourceKey]));
  assert.ok(byModel["Moto G67"], `models: ${Object.keys(byModel).join(", ")}`);
  assert.match(byModel["Moto G67"], /:MOTO:G67$/);
  assert.match(byModel["Moto G77"], /:MOTO:Moto G77$/);
});
