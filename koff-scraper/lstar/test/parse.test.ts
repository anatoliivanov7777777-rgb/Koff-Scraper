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

describe("parseProductPage: gallery, specification, description", () => {
  // Real markup of product 34497 (2026-10-19), trimmed to the parts we read.
  const html = `<html><body><a href="https://lstarbg.com/index.php?route=account/logout">Изход</a>
<div class="product-image direction-vertical position-left"> <div class="swiper main-image"> <div class="swiper-container"> <div class="swiper-wrapper">
<div class="swiper-slide" data-index="0"> <img src="https://lstarbg.com/image/cache/catalog/philcabvle2-550x550h.JPG" data-largeimg="https://lstarbg.com/image/cache/catalog/philcabvle2-1000x1000h.JPG" alt="2452 Philips кабел"> </div>
<div class="swiper-slide" data-index="1"> <img src="https://lstarbg.com/image/cache/catalog/philcabvle3-550x550h.JPG" data-largeimg="https://lstarbg.com/image/cache/catalog/philcabvle3-1000x1000h.JPG"> </div>
<div class="swiper-slide" data-index="2"> <img src="https://evil.example/x.jpg"> </div>
</div></div></div></div>
<ul class="nav nav-tabs"> <li class="active"> <a href="#product_tabs-6ad62698a1967" data-toggle="tab">Описание</a> </li> <li> <a href="#product_tabs-6ad62698a2260" data-toggle="tab">Спецификации</a> </li> </ul>
<div class="tab-content">
<div class="tab-pane active" id="product_tabs-6ad62698a1967"><div class="block-content"><div style="color:red">Кабел за синхронизиране и зареждане, <b>USB-A към USB-C</b>.</div></div></div>
<div class="tab-pane" id="product_tabs-6ad62698a2260"><div id="tab-specification"><table class="table table-bordered"><thead><tr><td colspan="2"><strong>Default</strong></td></tr></thead>
<tbody><tr><td>Тип</td><td>USB -TYPE C</td></tr><tr><td>Марка</td><td>Philips</td></tr><tr><td>Дължина</td><td>1.2M</td></tr></tbody></table></div></div>
</div>
<div class="product-price-group"><div class="product-price">€1.60</div><div class="product-stats"><ul>
<li class="product-stock in-stock"><b>Изчерпан:</b> <span>Наличен</span></li><li class="product-model"><b>Model:</b> <span>2170818</span></li></ul></div></div>
</body></html>`;
  const p = parseProductPage(html);

  it("takes the 1000×1000 gallery images, only from lstarbg.com, in order", () => {
    expect(p.images).toEqual([
      "https://lstarbg.com/image/cache/catalog/philcabvle2-1000x1000h.JPG",
      "https://lstarbg.com/image/cache/catalog/philcabvle3-1000x1000h.JPG",
    ]);
  });
  it("reads the specification table, without the header row", () => {
    expect(p.attributes).toEqual({ "Тип": "USB -TYPE C", "Марка": "Philips", "Дължина": "1.2M" });
  });
  it("finds the description tab by its label, as plain text", () => {
    expect(p.description).toBe("Кабел за синхронизиране и зареждане, USB-A към USB-C.");
  });
  it("no gallery, no table, no description tab: empty, not broken", () => {
    const bare = parseProductPage(productHtml({ name: "x", model: "1" }));
    expect(bare).toMatchObject({ images: [], attributes: {}, description: "" });
  });
});
