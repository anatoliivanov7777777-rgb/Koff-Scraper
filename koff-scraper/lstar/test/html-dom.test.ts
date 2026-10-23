// @vitest-environment jsdom
// Тестовият рън в браузъра чете HTML с DOMParser (src/html-dom.ts) вместо с
// node-html-parser. Тук проверяваме, че двете дават еднакъв резултат.
import { describe, expect, it, vi } from "vitest";
import * as viaNodeParser from "../src/parse.js";
import { categoryHtml, productHtml } from "./helpers.js";

async function loadViaDom() {
  vi.resetModules();
  vi.doMock("node-html-parser", () => import("../src/html-dom.js"));
  const mod = await import("../src/parse.js");
  const parserLib = await import("node-html-parser");
  expect(parserLib.parse.toString()).toContain("DOMParser"); // наистина е заменен
  vi.doUnmock("node-html-parser");
  return mod;
}

const categories = [
  categoryHtml({
    name: "Оригинални кейсове & калъфи",
    total: 93,
    cards: [
      { id: "36393", brand: "GUESS", handle: "3477-guess", variantPublicId: "95281488", price: 14.17 },
      { id: "36391", brand: "KARL", handle: "8694-karl", variantPublicId: "29137439", price: null },
      { id: "36390", brand: "KARL", handle: "3514-karl", variantPublicId: "63569432", price: null },
    ],
  }),
  categoryHtml({ name: "x", cards: [], loggedIn: false }),
];
const products = [
  productHtml({
    id: "36393", handle: "3477-guess", variantPublicId: "95281488",
    name: "Кейс & стъкло", brand: "GUESS", model: "2334081", netPrice: 14.17,
    specs: [{ label: "Марка", values: ["Guess"] }, { label: "Модел Телефон", values: ["iPhone 17", "iPhone 18"] }],
    descriptionHtml: "<p>Кейс &amp; стъкло</p>",
  }),
  productHtml({
    id: "2", handle: "k-2", variantPublicId: "102", name: "x", brand: "KARL",
    model: "8809640730515", netPrice: null, inStock: 0, availableForSale: false,
  }),
  productHtml({
    id: "3", handle: "k-3", variantPublicId: "103", name: "x", brand: "KARL",
    model: "1", netPrice: 20, salePrice: 16.38, basis: "inclusive",
  }),
];

describe("DOMParser реализацията = node-html-parser", () => {
  it("категории", async () => {
    const viaDom = await loadViaDom();
    for (const html of categories) {
      expect(viaDom.parseCategoryPage(html)).toEqual(viaNodeParser.parseCategoryPage(html));
    }
  });
  it("продуктови страници", async () => {
    const viaDom = await loadViaDom();
    for (const html of products) {
      expect(viaDom.parseProductPage(html)).toEqual(viaNodeParser.parseProductPage(html));
    }
  });
});
