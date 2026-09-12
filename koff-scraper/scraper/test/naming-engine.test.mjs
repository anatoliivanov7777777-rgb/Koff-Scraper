import { test } from "node:test";
import assert from "node:assert/strict";
import { generateProductName } from "../naming-engine.mjs";
import { normalizeColor, COLOR_MAP } from "../color-map.mjs";

test("CaseKing/Techsuit-style case input using publicMaker=CaseKing - engine itself never decides the rebrand, it just formats whatever publicMaker it's given", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "CaseKing",
    productLine: "CamShield Pro",
    deviceBrand: "Apple",
    deviceModel: "iPhone 16 Pro Max",
    color: "Black",
  });
  assert.equal(result.name, "Калъф CaseKing CamShield Pro за iPhone 16 Pro Max – черен");
  assert.equal(result.productType, "Калъф");
  assert.equal(result.normalizedColor, "черен");
  assert.deepEqual(result.warnings, []);
});

test("Spigen Ultra Hybrid T MagSafe example matches the exact spec output", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Spigen",
    productLine: "Ultra Hybrid T MagSafe",
    deviceBrand: "Apple",
    deviceModel: "iPhone 16",
    color: "White",
  });
  assert.equal(result.name, "Калъф Spigen Ultra Hybrid T MagSafe за iPhone 16 – бял");
});

test("iPhone Pro Max suffix is preserved exactly, not abbreviated or reordered", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "UAG",
    productLine: "Monarch",
    deviceBrand: "Apple",
    deviceModel: "iPhone 16 Pro Max",
  });
  assert.match(result.name, /iPhone 16 Pro Max/);
});

test("Samsung Ultra suffix is preserved exactly", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Ringke",
    productLine: "Fusion X",
    deviceBrand: "Samsung",
    deviceModel: "Samsung Galaxy S25 Ultra",
  });
  assert.match(result.name, /Samsung Galaxy S25 Ultra/);
});

test("FE suffix is preserved exactly", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Spigen",
    productLine: "Liquid Air",
    deviceBrand: "Samsung",
    deviceModel: "Samsung Galaxy S23 FE",
  });
  assert.match(result.name, /Samsung Galaxy S23 FE/);
});

test("5G suffix is preserved exactly", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Nillkin",
    productLine: "Frosty Series",
    deviceBrand: "Motorola",
    deviceModel: "Moto G84 5G",
  });
  assert.match(result.name, /Moto G84 5G/);
});

test("clear/transparent colors normalize to the same Bulgarian word", () => {
  assert.equal(normalizeColor("Clear"), "прозрачен");
  assert.equal(normalizeColor("Transparent"), "прозрачен");
  const result = generateProductName({
    categorySlug: "protektori-za-ekran",
    publicMaker: "Nillkin",
    productLine: "Tempered Glass",
    color: "Clear",
  });
  assert.match(result.name, /– прозрачен$/);
});

test("dark/light color variants normalize distinctly", () => {
  assert.equal(normalizeColor("Dark Blue"), "тъмносин");
  assert.equal(normalizeColor("Light Blue"), "светлосин");
  assert.equal(normalizeColor("Dark Green"), "тъмнозелен");
  assert.notEqual(normalizeColor("Dark Blue"), normalizeColor("Light Blue"));
});

test("unknown branded color name is preserved untranslated, with a warning, never silently mistranslated", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Apple",
    productLine: "Silicone Case",
    color: "Space Gray",
  });
  assert.equal(result.normalizedColor, null);
  assert.match(result.name, /Space Gray$/);
  assert.ok(result.warnings.some((w) => w.includes("Space Gray")));
});

test("missing color: no color clause, no warning, no trailing dash", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Spigen",
    productLine: "Tough Armor",
    deviceModel: "iPhone 16",
  });
  assert.equal(result.name, "Калъф Spigen Tough Armor за iPhone 16");
  assert.equal(result.normalizedColor, null);
  assert.equal(result.warnings.length, 0);
});

test("missing publicMaker: product line alone carries the name, no empty leading space", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    productLine: "CamShield Pro",
    deviceModel: "iPhone 16 Pro Max",
  });
  assert.equal(result.name, "Калъф CamShield Pro за iPhone 16 Pro Max");
});

test("missing productLine: maker alone carries the name", () => {
  const result = generateProductName({
    categorySlug: "vanshni-baterii",
    publicMaker: "Anker",
  });
  assert.equal(result.name, "Външна батерия Anker");
});

test("universal product with no device, no maker, no line, no color: type alone", () => {
  const result = generateProductName({ categorySlug: "keysove-i-kalufi" });
  assert.equal(result.name, "Калъф");
  assert.equal(result.warnings.length, 0);
});

test("duplicated device brand is avoided when deviceModel already contains deviceBrand", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Spigen",
    productLine: "Liquid Air",
    deviceBrand: "Samsung",
    deviceModel: "Samsung Galaxy S25 Ultra",
  });
  assert.match(result.name, /за Samsung Galaxy S25 Ultra/);
  assert.doesNotMatch(result.name, /Samsung Samsung/);
});

test("publicMaker already appearing at the start of productLine is not duplicated", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Spigen",
    productLine: "Spigen Rugged Armor",
    deviceModel: "iPhone 16",
  });
  assert.equal(result.name, "Калъф Spigen Rugged Armor за iPhone 16");
  assert.doesNotMatch(result.name, /Spigen Spigen/);
});

test("publicMaker appears at most once even when it is a short prefix-like word", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "UAG",
    productLine: "UAG Monarch",
  });
  const occurrences = (result.name.match(/UAG/g) || []).length;
  assert.equal(occurrences, 1);
});

test("product type: case (keysove-i-kalufi)", () => {
  assert.equal(generateProductName({ categorySlug: "keysove-i-kalufi" }).productType, "Калъф");
});

test("product type: screen protector (protektori-za-ekran, no camera-specific source category)", () => {
  const result = generateProductName({
    categorySlug: "protektori-za-ekran",
    sourceCategoryName: "Tempered Glass",
  });
  assert.equal(result.productType, "Протектор за екран");
});

test("product type: camera protector via exact allow-listed source category", () => {
  const result = generateProductName({
    categorySlug: "protektori-za-ekran",
    sourceCategoryName: "Camera Glass",
  });
  assert.equal(result.productType, "Протектор за камера");

  const result2 = generateProductName({
    categorySlug: "protektori-za-ekran",
    sourceCategoryName: "Lens Protector",
  });
  assert.equal(result2.productType, "Протектор за камера");
});

test("product type: charger (zaryadni-ustroystva)", () => {
  assert.equal(generateProductName({ categorySlug: "zaryadni-ustroystva" }).productType, "Зарядно");
});

test("product type: wireless charger (bezzhichni-zaryadni)", () => {
  assert.equal(
    generateProductName({ categorySlug: "bezzhichni-zaryadni" }).productType,
    "Безжично зарядно"
  );
});

test("product type: cable (kabeli-za-zaryadane)", () => {
  assert.equal(generateProductName({ categorySlug: "kabeli-za-zaryadane" }).productType, "Кабел");
});

test("product type: power bank (vanshni-baterii)", () => {
  assert.equal(
    generateProductName({ categorySlug: "vanshni-baterii" }).productType,
    "Външна батерия"
  );
});

test("product type: car charger via exact allow-listed source category", () => {
  const result = generateProductName({
    categorySlug: "aksesoari-za-avtomobili",
    sourceCategoryName: "Car Chargers",
  });
  assert.equal(result.productType, "Зарядно за кола");
  assert.equal(result.warnings.length, 0);
});

test("product type: car holder via exact allow-listed source category", () => {
  const result = generateProductName({
    categorySlug: "aksesoari-za-avtomobili",
    sourceCategoryName: "Car Holders",
  });
  assert.equal(result.productType, "Стойка за кола");
  assert.equal(result.warnings.length, 0);
});

test("product type: ambiguous car category without exact-known sourceCategoryName falls back safely with a warning", () => {
  const result = generateProductName({
    categorySlug: "aksesoari-za-avtomobili",
    sourceCategoryName: "Car Gadgets",
  });
  assert.equal(result.productType, "Аксесоар");
  assert.ok(result.warnings.length > 0);
});

test("product type: stand (postavki-za-byuro)", () => {
  assert.equal(generateProductName({ categorySlug: "postavki-za-byuro" }).productType, "Стойка");
});

test("product type: headphones", () => {
  assert.equal(generateProductName({ categorySlug: "headphones" }).productType, "Слушалки");
});

test("product type: watch accessory (aksesoari_chasovnici)", () => {
  assert.equal(
    generateProductName({ categorySlug: "aksesoari_chasovnici" }).productType,
    "Аксесоар"
  );
});

test("product type: popsoket-i-vrazki maps to the generic accessory type", () => {
  assert.equal(generateProductName({ categorySlug: "popsoket-i-vrazki" }).productType, "Аксесоар");
});

test("unknown category: safe fallback type with a warning, never inferred from free text", () => {
  const result = generateProductName({
    categorySlug: "some-brand-new-unmapped-slug",
    productLine: "Watch Charging Dock",
  });
  assert.equal(result.productType, "Аксесоар");
  assert.ok(result.warnings.some((w) => w.includes("some-brand-new-unmapped-slug")));
});

test("missing categorySlug entirely also falls back safely with a warning", () => {
  const result = generateProductName({});
  assert.equal(result.productType, "Аксесоар");
  assert.ok(result.warnings.length > 0);
});

test("no ALL-CAPS transformation is ever applied to maker/line/device text", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "UAG",
    productLine: "IML Series",
    deviceBrand: "Apple",
    deviceModel: "iPhone 16",
  });
  assert.match(result.name, /UAG/);
  assert.match(result.name, /IML Series/);
  assert.doesNotMatch(result.name, /^[A-ZА-Я\s]+$/); // whole string isn't all-caps
});

test("trademark/product-line text is never translated or rewritten (lossless)", () => {
  const lines = ["CamShield Pro", "Ultra Hybrid", "Cafule", "MagSafe", "Mix", "Series", "Hybrid Armor"];
  for (const productLine of lines) {
    const result = generateProductName({
      categorySlug: "keysove-i-kalufi",
      publicMaker: "CaseKing",
      productLine,
    });
    assert.ok(result.name.includes(productLine), `expected "${productLine}" to survive lossless in "${result.name}"`);
  }
});

test("whitespace and punctuation are normalized safely (no double spaces, trimmed)", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "  Spigen  ",
    productLine: "  Tough   Armor  ",
    deviceModel: "  iPhone   16  ",
    color: "  Black  ",
  });
  assert.equal(result.name, "Калъф Spigen Tough Armor за iPhone 16 – черен");
  assert.doesNotMatch(result.name, /\s{2,}/);
  assert.equal(result.name, result.name.trim());
});

test("engine never mutates the input object", () => {
  const input = Object.freeze({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "Spigen",
    productLine: "Tough Armor",
    deviceBrand: "Apple",
    deviceModel: "iPhone 16",
    color: "Black",
  });
  // A frozen object throws in strict mode if the engine tries to write to
  // it - calling this and getting a normal result (not a TypeError) is
  // itself proof of non-mutation, but we also snapshot for clarity.
  const snapshot = { ...input };
  const result = generateProductName(input);
  assert.deepEqual({ ...input }, snapshot);
  assert.ok(result.name.length > 0);
});

test("empty-string fields behave identically to undefined/missing fields", () => {
  const result = generateProductName({
    categorySlug: "keysove-i-kalufi",
    publicMaker: "",
    productLine: "",
    deviceBrand: "",
    deviceModel: "",
    color: "",
  });
  assert.equal(result.name, "Калъф");
  assert.equal(result.normalizedColor, null);
});

test("color map exposes only exact, case-insensitive full-string matches - no partial/substring matches", () => {
  assert.equal(normalizeColor("Blackish"), null);
  assert.equal(normalizeColor("Space Gray"), null);
  assert.equal(normalizeColor("black"), COLOR_MAP.black);
  assert.equal(normalizeColor("BLACK"), COLOR_MAP.black);
  assert.equal(normalizeColor(""), null);
  assert.equal(normalizeColor(undefined), null);
});

test("Matte Black is recognized as its own distinct entry, not conflated with plain Black", () => {
  assert.equal(normalizeColor("Matte Black"), "матово черен");
  assert.notEqual(normalizeColor("Matte Black"), normalizeColor("Black"));
});
