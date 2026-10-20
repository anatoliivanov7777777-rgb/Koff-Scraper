import { describe, expect, it } from "vitest";
import { buildShopRow, colourOf, devicesFor, devicesFromTitle, kindOf, lengthOf, powerOf } from "../src/shop-row.js";
import type { ScrapedProduct } from "../src/core.js";

function product(overrides: Partial<ScrapedProduct> = {}): ScrapedProduct {
  return {
    productId: "36393",
    url: "",
    categoryPath: "496_567",
    categoryName: "Оригинални кейсове",
    brand: "GUESS",
    name: "3477 GUESS HC MAGSAFE SW IP18 PRO MAX BLACK PU KEVLAR TRIANGLE LOGO",
    model: "2334081",
    sku: "GUHMP18X6PWKSGTK",
    ean: "",
    priceEur: 14.17,
    inStock: true,
    images: ["https://lstarbg.com/image/cache/catalog/GUHMP18X6PWKSGTK_1-1000x1000.jpg"],
    attributes: { "Бранд": "iPhone", "Модел Телефон": "iPhone 18 Pro Max,iPhone 17 Pro Max", "Марка": "Guess" },
    description: "",
    ...overrides,
  };
}

const rowOf = (p: ScrapedProduct) => {
  const result = buildShopRow(p);
  if ("skip" in result) throw new Error(result.skip);
  return result.row;
};

describe("a case", () => {
  it("is a Bulgarian scheme name for the phones LStar lists, prices without extra VAT", () => {
    const row = rowOf(product());
    expect(row).toMatchObject({
      sourceKey: "lstar-sync:36393",
      sourceProductId: 36393,
      category: "keysove-i-kalufi",
      brand: "Apple",
      model: "iPhone 18 Pro Max",
      compat: [{ brand: "Apple", model: "iPhone 17 Pro Max" }],
      publicMaker: "Guess",
      supplierSku: "GUHMP18X6PWKSGTK",
      priceB2C: 22.99,
      priceB2B: 20.99,
      costPrice: 14.17,
      stock: 5,
      needsModel: false,
      image: "https://lstarbg.com/image/cache/catalog/GUHMP18X6PWKSGTK_1-1000x1000.jpg",
    });
    expect(row.proposedName).toBe("Калъф Guess MagSafe SW PU Kevlar Triangle Logo за iPhone 18 Pro Max / iPhone 17 Pro Max - черен");
  });

  it("reads the phones from the title when the table has none", () => {
    expect(devicesFromTitle("8649 KARL HC MAGSAFE IP17 / 18 PRO BLACK")).toEqual([
      { brand: "Apple", model: "iPhone 17 Pro" }, { brand: "Apple", model: "iPhone 18 Pro" },
    ]);
    expect(devicesFromTitle("0084 MB HC MAGSAFE BLACK IPHONE 17 AIR")).toEqual([{ brand: "Apple", model: "iPhone 17 Air" }]);
    expect(devicesFromTitle("BMW iPhone 15 & 14 Plus естествена кожа")).toEqual([
      { brand: "Apple", model: "iPhone 15 Plus" }, { brand: "Apple", model: "iPhone 14 Plus" },
    ]);
    expect(devicesFromTitle("Guess Galaxy S24 Plus Back cover case")).toEqual([{ brand: "Samsung", model: "S24 Plus" }]);
  });

  it("joins the table and the title without repeating a phone", () => {
    const p = product({
      name: "PTDK 3350 BMW iPhone 15 & 14 Plus естествена кожа заден капак - трицветен печат - черен",
      attributes: { "Бранд": "iPhone", "Модел Телефон": "iPhone 15 Plus", "Марка": "BMW" },
    });
    expect(devicesFor(p).map((d) => d.model)).toEqual(["iPhone 15 Plus", "iPhone 14 Plus"]);
    expect(rowOf(p).proposedName).toBe("Калъф BMW естествена кожа трицветен печат за iPhone 15 Plus / iPhone 14 Plus - черен");
  });

  it("names a Samsung the way the shop does", () => {
    const p = product({ name: "1070 Guess Galaxy S24 Plus Back cover case - Rhinestone Triangle - Pink", attributes: {} });
    expect(rowOf(p).proposedName).toBe("Калъф Guess Rhinestone Triangle за Samsung Galaxy S24 Plus - розов");
  });

  it("is held back when no phone can be read", () => {
    const row = rowOf(product({ name: "GUESS HC MAGSAFE BLACK", attributes: {} }));
    expect(row).toMatchObject({ needsModel: true, brand: "Всички марки", model: "Всички модели" });
  });
});

describe("other kinds", () => {
  it("chargers, wireless chargers, cables, earbuds go to their shelves", () => {
    expect(kindOf("496_569", "Оригинален адаптер Samsung Fast charger 45W")).toBe("charger");
    expect(kindOf("496_569", "Оригинално Безжично Магнитно USB-C Зарядно APPLE Magsafe Charger 15W")).toBe("wireless-charger");
    expect(kindOf("496_570", "8057 Philips кабел HDMI 1,5 m")).toBe("hdmi-cable");
    expect(kindOf("496_567", "2213 GUESS TWS SMALL ROUND SCRIPT PRINT WHITE")).toBe("earbuds");
    expect(kindOf("999_1", "x")).toBeNull();
  });

  it("a charger: maker as brand, model-less, power and colour", () => {
    const row = rowOf(product({
      productId: "35413", categoryPath: "496_569", brand: "SAMSUNG", sku: "",
      name: "Оригинален адаптер Samsung Fast charger Trio 65W - Черен / EP-T6530NBEGEU-RETAIL",
      attributes: { "Тип": "220V", "Букса": "на USB-C", "Цвят": "Черен" }, priceEur: 24.25,
    }));
    expect(row).toMatchObject({ category: "zaryadni-ustroystva", brand: "Samsung", model: "Всички модели", compat: [], supplierSku: "" });
    expect(row.proposedName).toBe("Зарядно Samsung Fast Charger Trio, 65W - черно");
  });

  it("a cable: length from the table, both ends in Bulgarian", () => {
    const row = rowOf(product({
      productId: "34951", categoryPath: "496_570", brand: "PHILIPS", sku: "DLC5206C/00", ean: "4895229103825",
      name: "3825 Кабел PHILIPS USB-C към USB-C DLC5206C/00",
      attributes: { "Тип": "TYPE C - TYPE C", "Марка": "Philips", "Дължина": "1M" }, priceEur: 3.9,
    }));
    expect(row).toMatchObject({ category: "kabeli-za-zaryadane", ean: "4895229103825", supplierSku: "DLC5206C/00", priceB2C: 9.99 });
    expect(row.proposedName).toBe("Кабел Philips USB-C към USB-C, 1 м");
  });

  it("earbuds keep the plural colour", () => {
    const row = rowOf(product({ name: "2213 GUESS TWS SMALL ROUND SCRIPT PRINT WHITE", attributes: { "Марка": "GUESS" } }));
    expect(row).toMatchObject({ category: "headphones", brand: "Guess", model: "Всички модели" });
    expect(row.proposedName).toBe("Слушалки Guess TWS Small Round Script Print - бели");
  });
});

describe("details", () => {
  it("colours: the table first, then the title; a print is not a colour", () => {
    expect(colourOf(product({ attributes: { "Цвят": "Бял" } }), "n")).toBe("бяло");
    expect(colourOf(product({ name: "X - Мента", attributes: {} }), "m")).toBe("мента");
    expect(colourOf(product({ name: "GUESS HC MAGSAFE IP18 PRO L. BLUE PU", attributes: {} }), "m")).toBe("светлосин");
    expect(colourOf(product({ name: "Samsung Fast charger 25W - Бял /EP-TA800XWEGWW-BULK", attributes: {} }), "n")).toBe("бяло");
    expect(colourOf(product({ name: "GUESS HC 4G W/ IP18 PRO MAX PINK PU", attributes: {} }), "m")).toBe("розов");
  });

  it("power is the largest wattage; length in metres with a comma", () => {
    expect(powerOf("PHILIPS 38W DLP4325AB/12 Адаптер PD20W+QC18W")).toBe("38W");
    expect(powerOf("Samsung КАБЕЛ (25w) USB-C")).toBe("25W");
    expect(lengthOf(product({ name: "Philips кабел USB A to USB C 1.2M Cable", attributes: {} }))).toBe("1,2 м");
    expect(lengthOf(product({ name: "Philips кабел HDMI 1,5 m Standard", attributes: {} }))).toBe("1,5 м");
  });

  it("a product without a price is skipped; out of stock is stock 0", () => {
    expect(buildShopRow(product({ priceEur: null }))).toEqual({ skip: "няма цена" });
    expect(rowOf(product({ inStock: false })).stock).toBe(0);
    expect(rowOf(product({ inStock: null })).stock).toBe(0);
  });

  it("LStar's internal code and an EAN are never sent as the manufacturer's code", () => {
    expect(rowOf(product({ sku: "949736" })).supplierSku).toBe("");
    expect(rowOf(product({ sku: "3666339489977" })).supplierSku).toBe("");
  });
});
