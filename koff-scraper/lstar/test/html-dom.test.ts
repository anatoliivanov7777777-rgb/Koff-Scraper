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
    name: "Оригинални кейсове &amp; калъфи",
    total: 93,
    pages: 1,
    cards: [
      { id: "36393", brand: "GUESS", model: "2334081", name: "GUESS HC MAGSAFE &quot;SW&quot; IP18", price: "€14.17" },
      { id: "36391", brand: "KARL", model: "8809640730515", name: "KARL", price: null },
      { id: "36390", brand: "KARL", model: "KLHMP18X", name: "KARL промо", price: null, special: { old: "€20.00", new: "€16.38" } },
    ],
  }),
  categoryHtml({ name: "x", total: 0, pages: 1, cards: [], loggedIn: false }),
];
const products = [
  productHtml({ name: "Кейс &amp; стъкло", model: "2334081", sku: "GUHMP18X6PWKSGTK" }),
  productHtml({ name: "x", model: "8809640730515", price: null, inStock: false }),
  productHtml({ name: "x", model: "1", special: { old: "€20.00", new: "€16.38" } }),
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
