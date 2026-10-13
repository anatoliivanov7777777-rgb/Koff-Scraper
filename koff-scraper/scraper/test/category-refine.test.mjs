import test from "node:test";
import assert from "node:assert/strict";
import { refineCategorySlug, buildCaseKingProducts } from "../caseking-product-normalization.mjs";

// Real supplier titles from the 2026-10-12 category audit.
const cases = [
  ["protektori-za-ekran", "3mk - FlexibleGlass (3 pack) - Garmin Fenix 9 51mm", "aksesoari_chasovnici"],
  ["protektori-za-ekran", "Smart Protection - Premium Classic (4 pack) - Apple Watch 9 (40/41mm)", "aksesoari_chasovnici"],
  ["protektori-za-ekran", "Spigen - (2 pack) Glas.tR Slim, Back Screen (AGL11171) - Insta360 Go Ultra", "selfi-stikove"],
  ["protektori-za-ekran", "Spigen - GLAS.tR EZ Fit (AGL10820) - for 16'' Screen, Tesla 2026 Model Y", "aksesoari-za-avtomobili"],
  ["protektori-za-ekran", "3mk - CareWipe (24 pcs) - for Phone, Tablet and Monitor - White", "drugi"],
  ["protektori-za-ekran", "Spigen - Glas.tR EZ Fit (AGL07901) - iPhone 16 Pro - Clear", "protektori-za-ekran"],
  ["protektori-za-ekran", "ESR - Armorite Screen Protector UltraFit (2 pack) - iPhone 17 Pro", "protektori-za-ekran"],
  ["aksesoari_chasovnici", "Ringke - Rugged Gear - iPhone 16 Pro - Black", "keysove-i-kalufi"],
  ["aksesoari_chasovnici", "Techsuit - Defense360 Pro + Screen Protector - Samsung Galaxy S24 Plus - Black", "keysove-i-kalufi"],
  ["aksesoari_chasovnici", "Techsuit - Defense360 Pro + Screen Protector - Samsung Galaxy Watch 4 - Black", "aksesoari_chasovnici"],
  ["aksesoari_chasovnici", "Spigen - Nano Pop (ACS10134) - Apple AirPods Pro 3 - Orange Beige", "kalafi-za-slushalki"],
  ["aksesoari_chasovnici", "Techsuit - Watchband (W001) - Apple Watch 1/2/3 (38mm) - Black", "aksesoari_chasovnici"],
  ["keysove-i-kalufi", "Spigen - Core Armor (ACS09833) - Apple AirPods Pro 3 - Matte Black", "kalafi-za-slushalki"],
  ["keysove-i-kalufi", "Spigen - Ultra Hybrid MagFit - iPhone 16 Pro - Clear", "keysove-i-kalufi"],
  ["popsoket-i-vrazki", "Guess - Crossbody Cord 4G Big Logo (GUHCP17MP4GMGCRW) - Brown", "keysove-i-kalufi"],
  ["popsoket-i-vrazki", "Guess - Hardcase 4G Classic Logo with Strap (GUHCP17SP4GMGSK) - Black", "keysove-i-kalufi"],
  ["popsoket-i-vrazki", "CaseKing - Rope Crossbody Strap (RCS1-03) - for Phones, Carabiner, Nylon - Black", "popsoket-i-vrazki"],
  ["postavki-za-byuro", "Spigen - Valentinus MagFit Wallet (AFA06598) - 3 Cards - Orange", "popsoket-i-vrazki"],
  ["postavki-za-byuro", "ESR - HaloLock Kickstand Stand - Black", "postavki-za-byuro"],
  ["headphones", "Techsuit - Carbon Silicone - for AirPods 1 / AirPods 2 - Black", "kalafi-za-slushalki"],
  ["headphones", "UNIQ - Lino Hybrid Liquid Silicone Case - AirPods 4 - Green", "kalafi-za-slushalki"],
  ["headphones", "Guess - Wireless Earbuds Script Metal Logo (GUTWSX45PGSH) - Bluetooth V5.4, TWS, with Case", "headphones"],
  ["headphones", "Havit - Wireless Headphones H655BT Pro - ANC - Black", "headphones"],
  ["kabeli-za-zaryadane", "Baseus - Cable USB-C to USB-C 100W - Black", "kabeli-za-zaryadane"],
];

for (const [slug, name, expected] of cases) {
  test(`refineCategorySlug: ${slug} | ${name}`, () => {
    assert.equal(refineCategorySlug(slug, { name }), expected);
  });
}

test("refineCategorySlug leaves empty input alone", () => {
  assert.equal(refineCategorySlug(null, { name: "x" }), null);
  assert.equal(refineCategorySlug("protektori-za-ekran", {}), "protektori-za-ekran");
});

test("a refined row keeps its original sourceKey, so the sync still finds the existing product", () => {
  const raw = {
    sourceId: "TEST-1",
    name: "Ringke - Rugged Gear - iPhone 16 Pro - Black",
    manufacturer: "Ringke",
    category: "Smartwatch Cases",
    price: 10,
    stock: 3,
  };
  const rows = buildCaseKingProducts(raw, "aksesoari_chasovnici");
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.category, "keysove-i-kalufi");
    assert.match(row.sourceKey, /^koff-sync:TEST-1:aksesoari_chasovnici:/);
  }
});
