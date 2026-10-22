import { describe, expect, it } from "vitest";
import {
  classifyModel,
  isValidEan13,
  parseCategoryPage,
  parsePriceEur,
  parseProductPage,
  priceWithVat,
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

describe("priceWithVat", () => {
  it("цена без ДДС се умножава по множителя на сайта", () => {
    expect(priceWithVat(10, "exclusive", 1.2)).toBe(12);
    expect(priceWithVat(14.17, "exclusive", 1.2)).toBe(17);
    expect(priceWithVat(1.6, "exclusive", 1.2)).toBe(1.92);
  });
  it("цена с ДДС остава непроменена", () => {
    expect(priceWithVat(12, "inclusive", 1.2)).toBe(12);
  });
  it("без цена или с нула → null", () => {
    expect(priceWithVat(null, "exclusive", 1.2)).toBeNull();
    expect(priceWithVat(0, "exclusive", 1.2)).toBeNull();
  });
});

const cases = categoryHtml({
  name: "Оригинални кейсове",
  total: 3,
  cards: [
    { id: "36393", brand: "GUESS", handle: "3477-guess-hc", variantPublicId: "95281488", price: 14.17 },
    { id: "36391", brand: "KARL", handle: "8694-karl-hc", variantPublicId: "29137439", price: null },
    { id: "36390", brand: "KARL", handle: "3514-karl-hc", variantPublicId: "63569432", price: 16.38 },
  ],
});

describe("parseCategoryPage", () => {
  const page = parseCategoryPage(cases);

  it("чете име, общ брой и брой страници", () => {
    expect(page.name).toBe("Оригинални кейсове");
    expect(page.total).toBe(3);
    expect(page.pages).toBe(1);
    expect(page.loggedIn).toBe(true);
  });

  it("чете само продуктите от листинга, не и „Продукти на фокус“", () => {
    expect(page.products.map((p) => p.productId)).toEqual(["36393", "36391", "36390"]);
  });

  it("сглобява адреса на продукта от urlHandle и номера на варианта", () => {
    expect(page.products[0].url).toBe(
      "https://lstarbg.com/products/3477-guess-hc-95281488",
    );
  });

  it("чете марка, име и цена от листинга", () => {
    expect(page.products[0]).toMatchObject({ brand: "GUESS", priceEur: 14.17 });
    expect(page.products[1].priceEur).toBeNull();
    expect(page.products[2].priceEur).toBe(16.38);
  });

  it("изчислява страниците от общия брой (50 на страница)", () => {
    const many = categoryHtml({
      name: "Голяма",
      total: 120,
      cards: Array.from({ length: 50 }, (_, i) => ({
        id: String(1000 + i),
        brand: "A",
        handle: `h-${i}`,
        variantPublicId: String(10000000 + i),
        price: 1,
      })),
    });
    expect(parseCategoryPage(many).pages).toBe(3);
  });

  it("разпознава нелогната страница по pricesHidden", () => {
    const hidden = categoryHtml({ name: "x", cards: [], loggedIn: false });
    expect(parseCategoryPage(hidden).loggedIn).toBe(false);
  });
});

describe("parseProductPage", () => {
  it("чете model, SKU, цена, режим на ДДС и наличност", () => {
    const p = parseProductPage(
      productHtml({
        id: "36393",
        handle: "3477-guess-hc",
        variantPublicId: "95281488",
        name: "3477 GUESS HC MAGSAFE",
        brand: "GUESS",
        model: "2334081",
        netPrice: 14.17,
      }),
    );
    expect(p).toMatchObject({
      name: "3477 GUESS HC MAGSAFE",
      brand: "GUESS",
      model: "2334081",
      sku: "95281488",
      priceEur: 14.17,
      priceBasis: "exclusive",
      vatRatio: 1.2,
      inStock: true,
    });
  });

  it("предпочита mpn пред вътрешния номер на варианта", () => {
    const p = parseProductPage(
      productHtml({ id: "1", handle: "h", variantPublicId: "555", name: "x", brand: "B", mpn: "EP-TA800XWEGWW", netPrice: 9 }),
    );
    expect(p.sku).toBe("EP-TA800XWEGWW");
  });

  it("ползва промо цената, ако я има", () => {
    const p = parseProductPage(
      productHtml({ id: "1", handle: "h", variantPublicId: "555", name: "x", brand: "B", netPrice: 20, salePrice: 16.38 }),
    );
    expect(p.priceEur).toBe(16.38);
  });

  it("без цена и изчерпан", () => {
    const p = parseProductPage(
      productHtml({
        id: "1",
        handle: "h",
        variantPublicId: "555",
        name: "x",
        brand: "B",
        netPrice: null,
        inStock: 0,
        availableForSale: false,
      }),
    );
    expect(p.priceEur).toBeNull();
    expect(p.inStock).toBe(false);
  });

  it("чете снимките от галерията, само от lstarbg.com", () => {
    const p = parseProductPage(
      productHtml({
        id: "1",
        handle: "h",
        variantPublicId: "555",
        name: "x",
        brand: "B",
        netPrice: 1,
        images: ["/uploads/files/2026/09/a.avif", "https://evil.example/b.jpg", "/image/cache/catalog/c.jpg"],
      }),
    );
    expect(p.images).toEqual([
      "https://lstarbg.com/uploads/files/2026/09/a.avif",
      "https://lstarbg.com/image/cache/catalog/c.jpg",
    ]);
  });

  it("чете таблицата със спецификации като атрибути", () => {
    const p = parseProductPage(
      productHtml({
        id: "1",
        handle: "h",
        variantPublicId: "555",
        name: "x",
        brand: "B",
        netPrice: 1,
        specs: [
          { label: "Тип", values: ["USB -TYPE C"] },
          { label: "Марка", values: ["Philips"] },
          { label: "Модел Телефон", values: ["iPhone 17", "iPhone 18"] },
        ],
      }),
    );
    expect(p.attributes).toEqual({
      "Тип": "USB -TYPE C",
      "Марка": "Philips",
      "Модел Телефон": "iPhone 17, iPhone 18",
    });
  });

  it("описанието е чист текст, без HTML", () => {
    const p = parseProductPage(
      productHtml({
        id: "1",
        handle: "h",
        variantPublicId: "555",
        name: "x",
        brand: "B",
        netPrice: 1,
        descriptionHtml: "<p>Кабел за <b>зареждане</b>.</p>",
      }),
    );
    expect(p.description).toBe("Кабел за зареждане.");
  });

  it("без галерия, без таблица, без описание: празно, но не счупено", () => {
    const bare = parseProductPage(
      productHtml({
        id: "1",
        handle: "h",
        variantPublicId: "555",
        name: "x",
        brand: "B",
        netPrice: 1,
        images: [],
        specs: [],
      }),
    );
    expect(bare).toMatchObject({ images: [], attributes: {}, description: "" });
  });

  it("страница без продукт → ясна грешка, вместо празен ред", () => {
    expect(() => parseProductPage("<html><body>404</body></html>")).toThrow(/не съдържа продукт/);
  });
});
