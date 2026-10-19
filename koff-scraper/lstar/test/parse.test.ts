import { describe, expect, it } from "vitest";
import {
  classifyModel,
  isValidEan13,
  parseCategoryPage,
  parsePriceEur,
  parseProductPage,
} from "../src/parse.js";
import { categoryHtml, productHtml } from "./helpers.js";

describe("parsePriceEur", () => {
  it.each([
    ["€14.17", 14.17],
    ["14,17 €", 14.17],
    ["€1,234.56", 1234.56],
    ["1 234,56 €", 1234.56],
    ["€5", 5],
    ["", null],
    ["Цена при запитване", null],
  ])("%s → %s", (input, expected) => {
    expect(parsePriceEur(input)).toBe(expected);
  });
});

describe("classifyModel / EAN", () => {
  it("13 цифри = EAN, 7 цифри = вътрешен код, останалото = SKU", () => {
    expect(classifyModel("8809640730515")).toBe("ean");
    expect(classifyModel("2334081")).toBe("internal");
    expect(classifyModel("949736")).toBe("internal"); // реален 6-цифрен код от рън-а
    expect(classifyModel("DLP4325AB/12")).toBe("manufacturer");
    expect(classifyModel("EP-TA800XWEGWW")).toBe("manufacturer");
    expect(classifyModel("123456789012")).toBe("manufacturer"); // 12 цифри не е EAN
  });
  it("проверява контролната цифра", () => {
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });
});

describe("parseCategoryPage", () => {
  const html = categoryHtml({
    name: "Оригинални кейсове",
    total: 3,
    pages: 1,
    cards: [
      { id: "36393", brand: "GUESS", model: "2334081", name: "GUESS HC MAGSAFE &amp; LOGO", price: "€14.17" },
      { id: "36391", brand: "KARL", model: "8809640730515", name: "KARL кейс", price: null },
      { id: "36390", brand: "KARL", model: "KLHMP18X", name: "KARL промо", price: null, special: { old: "€20.00", new: "€16.38" } },
    ],
  });
  const page = parseCategoryPage(html);

  it("чете име, брой и страници", () => {
    expect(page.name).toBe("Оригинални кейсове");
    expect(page.total).toBe(3);
    expect(page.pages).toBe(1);
    expect(page.loggedIn).toBe(true);
  });

  it("чете само продуктите от листинга, не и „Продукти на фокус“", () => {
    expect(page.products.map((p) => p.productId)).toEqual(["36393", "36391", "36390"]);
  });

  it("чете марка, model, име и цена; промо цената има приоритет", () => {
    expect(page.products[0]).toMatchObject({ brand: "GUESS", model: "2334081", priceEur: 14.17 });
    expect(page.products[0].name).toContain("MAGSAFE");
    expect(page.products[1].priceEur).toBeNull();
    expect(page.products[2].priceEur).toBe(16.38);
    expect(page.products[0].url).toBe("https://lstarbg.com/index.php?route=product/product&product_id=36393");
  });

  it("разпознава нелогната страница", () => {
    expect(parseCategoryPage(categoryHtml({ name: "x", total: 0, pages: 1, cards: [], loggedIn: false })).loggedIn).toBe(false);
  });
});

describe("parseProductPage", () => {
  it("чете SKU, model, цена и наличност", () => {
    const p = parseProductPage(productHtml({ name: "GUESS кейс", model: "2334081", sku: "GUHMP18X6PWKSGTK" }));
    expect(p).toMatchObject({ model: "2334081", sku: "GUHMP18X6PWKSGTK", priceEur: 14.17, inStock: true, brand: "GUESS", loggedIn: true });
  });
  it("без цена и изчерпан", () => {
    const p = parseProductPage(productHtml({ name: "x", model: "1", price: null, inStock: false }));
    expect(p.priceEur).toBeNull();
    expect(p.inStock).toBe(false);
    expect(p.sku).toBe("");
  });
  it("промо цена на продуктовата страница", () => {
    const p = parseProductPage(productHtml({ name: "x", model: "1", special: { old: "€20.00", new: "€16.38" } }));
    expect(p.priceEur).toBe(16.38);
  });
});
