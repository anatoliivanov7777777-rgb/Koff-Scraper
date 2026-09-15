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
    category: "CamShield Series",
    basePrice: 5,
    stock: 10,
    ...overrides,
  };
}

function rawAccessory(overrides = {}) {
  return {
    // Deliberately a single-segment name (no " - " at all) - parse-names.mjs
    // has pre-existing quirks with 2- and 3-part names (e.g. a 2-part name
    // assigns the same segment to both productLine AND color; a 3-part
    // name whose middle segment doesn't look like a device model gets
    // that segment duplicated into productLine). Both are out of scope
    // for this phase (parse-names.mjs is not touched here), so the
    // fixture simply avoids triggering either.
    sourceId: "KF2367119",
    id: 380620,
    name: "Powerbank Line",
    manufacturer: "Techsuit",
    category: "Powerbanks",
    basePrice: 8,
    stock: 5,
    ...overrides,
  };
}

test("1. Techsuit case -> Bulgarian name using CaseKing", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.match(product.name, /^Калъф CaseKing CamShield Pro за .*iPhone 16 Pro Max – черен$/);
});

test("2. Spigen case -> Bulgarian name using Spigen", () => {
  const raw = rawPhoneCase({
    name: "Spigen - Ultra Hybrid - iPhone 16 - White",
    manufacturer: "Spigen",
    category: "Ultra Hybrid",
  });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.match(product.name, /^Калъф Spigen Ultra Hybrid за .*iPhone 16 – бял$/);
});

test("3. recognized Black -> черен", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.match(product.name, /– черен$/);
});

test("4. Clear -> прозрачен", () => {
  const raw = rawPhoneCase({
    name: "Nillkin - Tempered Glass - iPhone 16 - Clear",
    manufacturer: "Nillkin",
    category: "Tempered Glass",
  });
  const [product] = buildCaseKingProducts(raw, "protektori-za-ekran");
  assert.match(product.name, /– прозрачен$/);
});

test("5. unknown branded color preserved + warning", () => {
  const raw = rawPhoneCase({
    name: "Techsuit - CamShield Pro - iPhone 16 Pro Max - Space Gray",
    category: "CamShield Series",
  });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.match(product.name, /– Space Gray$/);
  assert.ok(product._namingWarnings.some((w) => w.includes("Space Gray")));
});

test("6. exact device suffix preserved: Pro Max", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.match(product.name, /iPhone 16 Pro Max/);
});

test("7. Samsung Ultra compatibility survives", () => {
  // Phase E2: deviceLabel() now always shows "Samsung Galaxy ..." exactly
  // once, regardless of whether brand-model.mjs's parsing stripped the
  // "Galaxy" token from the stored model - this is a display-only fix,
  // stored brand/model stay whatever brand-model.mjs produced.
  const raw = rawPhoneCase({
    name: "Ringke - Fusion X - Samsung Galaxy S25 Ultra - Black",
    manufacturer: "Ringke",
    category: "Fusion X",
  });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.match(product.name, /Samsung Galaxy S25 Ultra/);
});

test("8. FE / 5G survive", () => {
  const feRaw = rawPhoneCase({
    name: "Spigen - Liquid Air - Samsung Galaxy S23 FE - Black",
    manufacturer: "Spigen",
    category: "Liquid Air",
  });
  const [feProduct] = buildCaseKingProducts(feRaw, "keysove-i-kalufi");
  assert.match(feProduct.name, /Samsung Galaxy S23 FE/);

  const gRaw = rawPhoneCase({
    name: "Nillkin - Frosty Series - Moto G84 5G - Black",
    manufacturer: "Nillkin",
    category: "Frosty Series",
  });
  const [gProduct] = buildCaseKingProducts(gRaw, "keysove-i-kalufi");
  // Phase E2: display now shows the real brand name "Motorola Moto ..."
  // instead of the bare stored "MOTO" identity string - the "5G" suffix
  // still survives either way.
  assert.match(gProduct.name, /Motorola Moto G84 5G/);
});

test("9. universal/unresolved product gets no fabricated \"за ...\" clause", () => {
  const raw = rawAccessory({ name: "Techsuit - Universal cases - Black", category: "Universal cases" });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.doesNotMatch(product.name, /за/);
  assert.doesNotMatch(product.name, /универсал/i);
  assert.doesNotMatch(product.name, /за всички/i);
});

test("10. Techsuit accessory name uses CaseKing", () => {
  const [product] = buildCaseKingProducts(rawAccessory(), "vanshni-baterii");
  assert.equal(product.name, "Външна батерия CaseKing Powerbank Line");
});

test("11. Techsuit accessory sourceKey still contains Techsuit", () => {
  const [product] = buildCaseKingProducts(rawAccessory(), "vanshni-baterii");
  assert.equal(product.sourceKey, "koff-sync:KF2367119:vanshni-baterii:Techsuit:all");
});

test("12. Techsuit sourceProductId unchanged", () => {
  const [product] = buildCaseKingProducts(rawAccessory({ sourceProductId: 380620 }), "vanshni-baterii");
  assert.equal(product.sourceProductId, 380620);
});

test("13. non-Techsuit accessory identity unchanged", () => {
  const raw = rawAccessory({ manufacturer: "mcdodo", name: "Mcdodo - Powerbank Line - Black" });
  const [product] = buildCaseKingProducts(raw, "vanshni-baterii");
  assert.equal(product.publicMaker, "Mcdodo");
  assert.equal(product.brand, "Mcdodo");
  assert.equal(product.sourceKey, "koff-sync:KF2367119:vanshni-baterii:Mcdodo:all");
  assert.match(product.name, /^Външна батерия Mcdodo Powerbank Line/);
});

test("14. hydrogel type", () => {
  const raw = rawPhoneCase({
    name: "Techsuit - Hydrogel Film - iPhone 16 - Clear",
    category: "Hydrogel",
  });
  const [product] = buildCaseKingProducts(raw, "hydrogel_film");
  assert.match(product.name, /^Хидрогел фолио CaseKing/);
});

test("15. memory card exact classification", () => {
  const raw = rawAccessory({
    name: "SanDisk - Ultra Line - Black",
    manufacturer: "sandisk",
    category: "Memory cards",
  });
  const [product] = buildCaseKingProducts(raw, "memory_cards");
  assert.match(product.name, /^Карта памет SanDisk/);
});

test("16. USB memory exact classification", () => {
  const raw = rawAccessory({
    name: "Kingston - DataTraveler - Black",
    manufacturer: "kingston",
    category: "Memory sticks",
  });
  const [product] = buildCaseKingProducts(raw, "memory_cards");
  assert.match(product.name, /^USB памет Kingston/);
});

test("17. card reader exact classification", () => {
  const raw = rawAccessory({
    name: "Ugreen - CardReader Line - Black",
    manufacturer: "ugreen",
    category: "Card readers",
  });
  const [product] = buildCaseKingProducts(raw, "memory_cards");
  assert.match(product.name, /^Четец за карти Ugreen/);
});

test("18. audio cable classification", () => {
  const raw = rawAccessory({
    name: "Baseus - AudioLink - Black",
    manufacturer: "baseus",
    category: "Jack 3.5mm",
  });
  const [product] = buildCaseKingProducts(raw, "audio_cables");
  assert.match(product.name, /^Аудио кабел Baseus/);
});

test("19. car charger", () => {
  const raw = rawAccessory({
    name: "Hoco - CarCharge Line - Black",
    manufacturer: "hoco",
    category: "Car Chargers",
  });
  const [product] = buildCaseKingProducts(raw, "aksesoari-za-avtomobili");
  assert.match(product.name, /^Зарядно за кола Hoco/);
});

test("20. car holder", () => {
  const raw = rawAccessory({
    name: "Baseus - CarMount Line - Black",
    manufacturer: "baseus",
    category: "Car Holders",
  });
  const [product] = buildCaseKingProducts(raw, "aksesoari-za-avtomobili");
  assert.match(product.name, /^Стойка за кола Baseus/);
});

test("21. wireless car holder", () => {
  const raw = rawAccessory({
    name: "Baseus - CarMount Wireless Line - Black",
    manufacturer: "baseus",
    category: "Car Holders with Wireless Charging",
  });
  const [product] = buildCaseKingProducts(raw, "aksesoari-za-avtomobili");
  assert.match(product.name, /^Стойка с безжично зареждане за кола Baseus/);
});

test("22. selfie category safe naming", () => {
  const raw = rawAccessory({
    name: "UNIQ - SelfieStick Line - Black",
    manufacturer: "UNIQ",
    category: "Selfie / Vlogging",
  });
  const [product] = buildCaseKingProducts(raw, "selfi-stikove");
  assert.match(product.name, /^Аксесоар за селфи UNIQ/);
});

test("23. lanyard/link strap naming", () => {
  const raw = rawAccessory({
    name: "UNIQ - LinX Lanyard Strap - Black",
    manufacturer: "UNIQ",
    category: "Lanyard Strap",
  });
  const [product] = buildCaseKingProducts(raw, "popsoket-i-vrazki");
  assert.match(product.name, /^Връзка за телефон UNIQ/);
});

test("24. camera protector existing refinement still works", () => {
  const raw = rawPhoneCase({
    name: "3mk - Camera Lens Protector - iPhone 16 Pro Max - Clear",
    manufacturer: "3mk",
    category: "Camera Lens Protector",
  });
  const [product] = buildCaseKingProducts(raw, "protektori-za-ekran");
  assert.match(product.name, /^Протектор за камера 3mk/);
});

test("25. screen protector existing behavior still works", () => {
  const raw = rawPhoneCase({
    name: "Nillkin - Tempered Glass - iPhone 16 - Clear",
    manufacturer: "Nillkin",
    category: "Tempered Glass",
  });
  const [product] = buildCaseKingProducts(raw, "protektori-za-ekran");
  assert.match(product.name, /^Протектор за екран Nillkin/);
});

test("26. watch case uses case-style product type while the stored category becomes the watch slug", () => {
  const raw = rawPhoneCase({
    name: "Spigen - Rugged Armor - Apple Watch Ultra 2 - Black",
    manufacturer: "Spigen",
    category: "SmartWatch Cases",
  });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.category, "aksesoari_chasovnici");
  assert.match(product.name, /^Калъф Spigen Rugged Armor за/);
  assert.doesNotMatch(product.name, /^Аксесоар/);
});

test("27. watch sourceKey unchanged (still built from the watch-remapped slug and device brand/model)", () => {
  const raw = rawPhoneCase({
    name: "Spigen - Rugged Armor - Apple Watch Ultra 2 - Black",
    manufacturer: "Spigen",
    category: "SmartWatch Cases",
  });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.sourceKey, "koff-sync:KF1000001:aksesoari_chasovnici:Apple Watch:Watch Ultra 2");
});

test("28. productLine with Mix/Series survives unchanged in the generated name", () => {
  const mixRaw = rawPhoneCase({
    name: "Guess - Guess Mix - iPhone 16 - Black",
    manufacturer: "Guess",
    category: "Guess Mix",
  });
  const [mixProduct] = buildCaseKingProducts(mixRaw, "keysove-i-kalufi");
  assert.match(mixProduct.name, /Mix/);

  const seriesRaw = rawPhoneCase({
    name: "UAG - Flagship Series - iPhone 16 - Black",
    manufacturer: "UAG",
    category: "Flagship Series",
  });
  const [seriesProduct] = buildCaseKingProducts(seriesRaw, "keysove-i-kalufi");
  assert.match(seriesProduct.name, /Series/);
});

test("29. publicMaker never appears twice in the generated name", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  const occurrences = (product.name.match(/CaseKing/g) || []).length;
  assert.equal(occurrences, 1);
});

test("30. no naming-warning field reaches the eventual Convex payload stripping step", () => {
  const source = readFileSync(new URL("../sync-caseking.mjs", import.meta.url), "utf8");
  assert.match(source, /_isWatch, _isAccessory, _namingWarnings, \.\.\.rest/);
});

test("31. existing trust-accuracy empty specs remain", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.equal(product.specs.material, "");
  assert.equal(product.specs.weight, "");
  assert.equal(product.specs.origin, "");
  assert.equal(product.specs.delivery, "");
});

test("32. description behavior remains (empty when absent, preserved trimmed when present)", () => {
  const [withoutDesc] = buildCaseKingProducts(rawPhoneCase({ description: undefined }), "keysove-i-kalufi");
  assert.equal(withoutDesc.description, "");
  const [withDesc] = buildCaseKingProducts(rawPhoneCase({ description: "  Real one.  " }), "keysove-i-kalufi");
  assert.equal(withDesc.description, "Real one.");
});

test("33. pricing unchanged", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase({ basePrice: 5 }), "keysove-i-kalufi");
  assert.ok(product.priceB2C > 0);
  assert.ok(product.priceB2B > 0);
});

test("34. image behavior unchanged", () => {
  const [product] = buildCaseKingProducts(rawPhoneCase(), "keysove-i-kalufi");
  assert.equal("image" in product, false);
  assert.equal("images" in product, false);
});

test("35. no blind Techsuit string replacement exists anywhere in sync-caseking.mjs", () => {
  const source = readFileSync(new URL("../sync-caseking.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /replace\([^)]*Techsuit/i);
  assert.doesNotMatch(source, /replaceAll\([^)]*Techsuit/i);
});
