import { describe, expect, it } from "vitest";
import { scrapeLstar, SessionLostError, toCsv } from "../src/core.js";
import { createLstarClient } from "../src/client.js";
import { categoryHtml, productHtml } from "./helpers.js";

function fakeSite(pages: Record<string, string>) {
  const calls: string[] = [];
  const fetchText = async (url: string) => {
    calls.push(url);
    const key = Object.keys(pages).find((k) => url.includes(k));
    if (!key) throw new Error(`no fixture for ${url}`);
    return pages[key];
  };
  return { fetchText, calls };
}

const cases = categoryHtml({
  name: "Оригинални кейсове",
  total: 3,
  pages: 1,
  cards: [
    { id: "1", brand: "GUESS", model: "2334081", name: "Кейс 1; с точка и запетая", price: "€14.17" },
    { id: "2", brand: "KARL", model: "8809640730515", name: "Кейс 2", price: null },
    { id: "3", brand: "KARL", model: "KLHMP18X", name: "Кейс 3", price: null },
  ],
});
const chargers = categoryHtml({
  name: "Оригинални зарядни и адаптери",
  total: 2,
  pages: 1,
  path: "496_569",
  cards: [
    { id: "4", brand: "SAMSUNG", model: "8894219", name: "Адаптер", price: "€9.50" },
    { id: "1", brand: "GUESS", model: "2334081", name: "Кейс 1", price: "€14.17" },
  ],
});

const site = {
  "path=496_567": cases,
  "path=496_569": chargers,
  "product_id=1": productHtml({ name: "Кейс 1", model: "2334081", sku: "GUHMP18X6PWKSGTK" }),
  "product_id=2": productHtml({ name: "Кейс 2", model: "8809640730515", sku: "", price: "€11.00" }),
  "product_id=3": productHtml({ name: "Кейс 3", model: "KLHMP18X", price: null, inStock: false }),
  "product_id=4": productHtml({ name: "Адаптер", model: "8894219", sku: "EP-T6530NBEGEU", price: "€9.70" }),
};

describe("scrapeLstar", () => {
  it("попълва липсващи цени от продуктовата страница и отбелязва липсващите навсякъде", async () => {
    const { fetchText } = fakeSite(site);
    const { rows, report } = await scrapeLstar({ fetchText, categoryPaths: ["496_567", "496_569"], vatIncluded: "yes" });

    expect(rows.map((r) => r.price_eur)).toEqual(["14.17", "11.00", "", "9.50"]);
    expect(rows[1].note).toContain("цена от продуктовата страница");
    expect(rows[2].note).toContain("НЯМА ЦЕНА");
    expect(rows[2].note).toContain("изчерпан");
    expect(rows[3].note).toContain("цена в листинга 9.50, на страницата 9.70");

    expect(report.categories[0]).toMatchObject({
      name: "Оригинални кейсове",
      declaredTotal: 3,
      scraped: 3,
      missingPriceInListing: 2,
      priceFilledFromProductPage: 1,
      missingPriceEverywhere: 1,
      outOfStock: 1,
    });
    expect(report.categories[1].name).toBe("Оригинални зарядни и адаптери");
    expect(report.duplicatesAcrossCategories).toBe(1);
    expect(report.uniqueProducts).toBe(4);
  });

  it("EAN само при 13-цифрен model; SKU от продуктовата страница", async () => {
    const { fetchText } = fakeSite(site);
    const { rows } = await scrapeLstar({ fetchText, categoryPaths: ["496_567"] });
    expect(rows[0]).toMatchObject({ sku: "GUHMP18X6PWKSGTK", ean: "" });
    expect(rows[0].note).toContain("вътрешен код 2334081");
    expect(rows[1]).toMatchObject({ ean: "8809640730515", sku: "" });
    expect(rows[2]).toMatchObject({ sku: "KLHMP18X", ean: "" }); // model е SKU на производителя
    expect(rows.every((r) => r.price_vat_included === "unconfirmed")).toBe(true);
  });

  it("обхожда всички страници на категорията", async () => {
    const p1 = categoryHtml({ name: "Голяма", total: 2, pages: 2, cards: [{ id: "1", brand: "A", model: "1111111", name: "a", price: "€1.00" }] });
    const p2 = categoryHtml({ name: "Голяма", total: 2, pages: 2, page: 2, cards: [{ id: "5", brand: "A", model: "2222222", name: "b", price: "€2.00" }] });
    const { fetchText, calls } = fakeSite({
      "page=1": p1,
      "page=2": p2,
      "product_id=1": productHtml({ name: "a", model: "1111111" }),
      "product_id=5": productHtml({ name: "b", model: "2222222" }),
    });
    const { rows } = await scrapeLstar({ fetchText, categoryPaths: ["496_567"] });
    expect(rows).toHaveLength(2);
    expect(calls.filter((c) => c.includes("route=product/category"))).toHaveLength(2);
    expect(calls[0]).toContain("limit=100");
  });

  it("спира при изгубена сесия, вместо да пише непълни данни", async () => {
    const { fetchText } = fakeSite({ "path=496_567": categoryHtml({ name: "x", total: 0, pages: 1, cards: [], loggedIn: false }) });
    await expect(scrapeLstar({ fetchText, categoryPaths: ["496_567"] })).rejects.toBeInstanceOf(SessionLostError);
  });
});

describe("toCsv", () => {
  it("заглавен ред, ; разделител, кавички при нужда", () => {
    const csv = toCsv([{ brand: "GUESS", name: 'Кейс; "MagSafe"', sku: "X", ean: "", price_eur: "14.17", price_vat_included: "yes", note: "" }]);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("brand;name;sku;ean;price_eur;price_vat_included;note");
    expect(lines[1]).toBe('GUESS;"Кейс; ""MagSafe""";X;;14.17;yes;');
  });
});

describe("createLstarClient", () => {
  it("влиза през OpenCart формата и не логва паролата", async () => {
    const logs: string[] = [];
    const requests: { url: string; method: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      requests.push({ url, method: init.method ?? "GET", body: String(init.body ?? "") });
      const headers = new Headers({ "set-cookie": "OCSESSID=abc; path=/" });
      if (url.includes("account/account")) return new Response('<a href="index.php?route=account/logout">x</a>', { headers });
      return new Response("ok", { headers });
    }) as unknown as typeof fetch;
    const client = createLstarClient({ email: "e@x.bg", password: "s3cret", fetchImpl, minIntervalMs: 0, log: (m) => logs.push(m) });
    await client.login();
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toContain("route=account/login");
    expect(post?.body).toContain("email=e%40x.bg");
    expect(logs.join(" ")).not.toContain("s3cret");
    expect(logs.join(" ")).not.toContain("abc");
  });

  it("съобщава за неуспешен вход", async () => {
    const fetchImpl = (async () => new Response("<form>login</form>")) as unknown as typeof fetch;
    const client = createLstarClient({ email: "e", password: "p", fetchImpl, minIntervalMs: 0 });
    await expect(client.login()).rejects.toThrow(/не успя/);
  });

  it("отказва заявки извън lstarbg.com", async () => {
    const client = createLstarClient({ email: "e", password: "p", fetchImpl: (async () => new Response("")) as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(client.fetchText("https://evil.example/")).rejects.toThrow(/извън/);
  });
});
