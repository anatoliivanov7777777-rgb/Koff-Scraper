import { describe, expect, it } from "vitest";
import { scrapeLstar, SessionLostError, toCsv } from "../src/core.js";
import {
  buildMultipart,
  createLstarClient,
  loginErrorMessage,
  parseLoginForm,
} from "../src/client.js";
import { categoryHtml, productHtml } from "./helpers.js";

const BASE = "https://lstarbg.com";
const CASES = `${BASE}/categories/originalni-aksesoari/originalni-keysove`;
const CHARGERS = `${BASE}/categories/originalni-aksesoari/originalni-zaryadni-i-adapteri`;

/** Стар адрес -> нов адрес (както 308 пренасочването на живия сайт). */
const redirects: Record<string, string> = {
  [`${BASE}/index.php?route=product/category&path=496_567`]: CASES,
  [`${BASE}/index.php?route=product/category&path=496_569`]: CHARGERS,
};

const productUrl = (handle: string, variant: string) => `${BASE}/products/${handle}-${variant}`;

const cases = categoryHtml({
  name: "Оригинални кейсове",
  total: 3,
  cards: [
    { id: "1", brand: "GUESS", handle: "k-1", variantPublicId: "101", price: 11.8 },
    { id: "2", brand: "KARL", handle: "k-2", variantPublicId: "102", price: null },
    { id: "3", brand: "KARL", handle: "k-3", variantPublicId: "103", price: null },
  ],
});
const chargers = categoryHtml({
  name: "Оригинални зарядни и адаптери",
  total: 2,
  cards: [
    { id: "4", brand: "SAMSUNG", handle: "c-4", variantPublicId: "104", price: 7.92 },
    { id: "1", brand: "GUESS", handle: "k-1", variantPublicId: "101", price: 11.8 },
  ],
});

const products: Record<string, string> = {
  [productUrl("k-1", "101")]: productHtml({
    id: "1", handle: "k-1", variantPublicId: "101", name: "Кейс 1; с точка и запетая",
    brand: "GUESS", model: "2334081", netPrice: 11.8,
  }),
  [productUrl("k-2", "102")]: productHtml({
    id: "2", handle: "k-2", variantPublicId: "102", name: "Кейс 2",
    brand: "KARL", model: "8809640730515", netPrice: 11, mpn: "KLHMP18X",
  }),
  [productUrl("k-3", "103")]: productHtml({
    id: "3", handle: "k-3", variantPublicId: "103", name: "Кейс 3",
    brand: "KARL", model: "KLHMP18X", netPrice: null, inStock: 0, availableForSale: false,
  }),
  [productUrl("c-4", "104")]: productHtml({
    id: "4", handle: "c-4", variantPublicId: "104", name: "Адаптер",
    brand: "SAMSUNG", model: "8894219", mpn: "EP-T6530NBEGEU", netPrice: 8.08,
  }),
};

function fakeSite(pages: Record<string, string>) {
  const calls: string[] = [];
  const resolveUrl = async (url: string) => {
    calls.push(`resolve ${url}`);
    return redirects[url] ?? url;
  };
  const fetchText = async (url: string) => {
    calls.push(url);
    const html = pages[url];
    if (html === undefined) throw new Error(`no fixture for ${url}`);
    return html;
  };
  return { fetchText, resolveUrl, calls };
}

const site = { [CASES]: cases, [CHARGERS]: chargers, ...products };

describe("scrapeLstar", () => {
  it("превръща показаните без ДДС цени в цени с ДДС", async () => {
    const { fetchText, resolveUrl } = fakeSite(site);
    const { rows, report } = await scrapeLstar({
      fetchText, resolveUrl, categoryPaths: ["496_567", "496_569"], vatIncluded: "yes",
    });

    // 11.80 x 1.2 = 14.16; 7.92 x 1.2 = 9.50; на страницата 8.08 x 1.2 = 9.70
    expect(rows.map((r) => r.price_eur)).toEqual(["14.16", "13.20", "", "9.50"]);
    expect(report.priceBasis).toContain("без ДДС");
    expect(rows[1].note).toContain("цена от продуктовата страница");
    expect(rows[2].note).toContain("НЯМА ЦЕНА");
    expect(rows[2].note).toContain("изчерпан");
    expect(rows[3].note).toContain("цена в листинга 9.50, на страницата 9.70");
  });

  it("брои по категории и хваща дубликатите между тях", async () => {
    const { fetchText, resolveUrl } = fakeSite(site);
    const { report } = await scrapeLstar({ fetchText, resolveUrl, categoryPaths: ["496_567", "496_569"] });

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

  it("EAN само при 13-цифрен model; SKU само истински код на производителя", async () => {
    const { fetchText, resolveUrl } = fakeSite(site);
    const { rows } = await scrapeLstar({ fetchText, resolveUrl, categoryPaths: ["496_567"] });

    // Вътрешният номер на варианта (101) не е SKU и не влиза в колоната.
    expect(rows[0]).toMatchObject({ sku: "", ean: "" });
    expect(rows[0].note).toContain("вътрешен код 2334081");
    expect(rows[0].note).toContain("няма SKU на производителя");
    expect(rows[1]).toMatchObject({ ean: "8809640730515", sku: "KLHMP18X" });
    expect(rows[2]).toMatchObject({ sku: "KLHMP18X", ean: "" });
    expect(rows.every((r) => r.price_vat_included === "unconfirmed")).toBe(true);
  });

  it("превежда старите адреси на категориите през пренасочването", async () => {
    const { fetchText, resolveUrl, calls } = fakeSite(site);
    await scrapeLstar({ fetchText, resolveUrl, categoryPaths: ["496_567"] });
    expect(calls[0]).toBe(`resolve ${BASE}/index.php?route=product/category&path=496_567`);
    expect(calls[1]).toBe(CASES);
  });

  it("обхожда всички страници на категорията (?page=2, 50 на страница)", async () => {
    const p1 = categoryHtml({
      name: "Голяма", total: 51,
      cards: Array.from({ length: 50 }, (_, i) => ({
        id: String(1000 + i), brand: "A", handle: `h-${i}`, variantPublicId: String(2000 + i), price: 1,
      })),
    });
    const p2 = categoryHtml({
      name: "Голяма", total: 51,
      cards: [{ id: "2000", brand: "A", handle: "h-last", variantPublicId: "3000", price: 2 }],
    });
    const pages: Record<string, string> = {
      [CASES]: p1,
      [`${CASES}?page=2`]: p2,
      ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [
        productUrl(`h-${i}`, String(2000 + i)),
        productHtml({ id: String(1000 + i), handle: `h-${i}`, variantPublicId: String(2000 + i), name: `p${i}`, brand: "A", netPrice: 1 }),
      ])),
      [productUrl("h-last", "3000")]: productHtml({
        id: "2000", handle: "h-last", variantPublicId: "3000", name: "last", brand: "A", netPrice: 2,
      }),
    };
    const { fetchText, resolveUrl, calls } = fakeSite(pages);
    const { rows } = await scrapeLstar({ fetchText, resolveUrl, categoryPaths: ["496_567"] });
    expect(rows).toHaveLength(51);
    expect(calls).toContain(`${CASES}?page=2`);
  });

  it("спира при изгубена сесия, вместо да пише непълни данни", async () => {
    const hidden = categoryHtml({
      name: "x", loggedIn: false,
      cards: [{ id: "1", brand: "A", handle: "h", variantPublicId: "2", price: null }],
    });
    const { fetchText, resolveUrl } = fakeSite({ [CASES]: hidden });
    await expect(scrapeLstar({ fetchText, resolveUrl, categoryPaths: ["496_567"] })).rejects.toBeInstanceOf(SessionLostError);
  });

  it("спира, ако нито един продукт няма цена (сайтът крие цените)", async () => {
    const cards = Array.from({ length: 6 }, (_, i) => ({
      id: String(500 + i), brand: "A", handle: `z-${i}`, variantPublicId: String(900 + i), price: null,
    }));
    const pages: Record<string, string> = { [CASES]: categoryHtml({ name: "z", cards }) };
    for (const c of cards) {
      pages[productUrl(c.handle, c.variantPublicId)] = productHtml({
        id: c.id, handle: c.handle, variantPublicId: c.variantPublicId,
        name: c.handle, brand: "A", netPrice: null,
      });
    }
    const { fetchText, resolveUrl } = fakeSite(pages);
    await expect(scrapeLstar({ fetchText, resolveUrl, categoryPaths: ["496_567"] })).rejects.toBeInstanceOf(SessionLostError);
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

// ---- Вход в новия сайт ---------------------------------------------------------

const signInPage = `<!DOCTYPE html><html><body>
<form class="flex" action="" encType="multipart/form-data" method="POST">
  <input type="hidden" name="$ACTION_REF_1"/>
  <input type="hidden" name="$ACTION_1:0" value="{&quot;id&quot;:&quot;60163e504b5f4a00&quot;,&quot;bound&quot;:&quot;$@1&quot;}"/>
  <input type="hidden" name="$ACTION_1:1" value="[null]"/>
  <input type="hidden" name="$ACTION_KEY" value="ka01a90ed6b59571b92de026da232b93c"/>
  <input id="email" type="email" name="email" value=""/>
  <input id="password" type="password" name="password" value=""/>
  <button type="submit">Вход</button>
</form></body></html>`;

const failedSignInPage = signInPage.replace(
  'name="$ACTION_1:1" value="[null]"',
  'name="$ACTION_1:1" value="[{&quot;ok&quot;:false,&quot;error&quot;:&quot;Невалиден имейл или парола.&quot;}]"',
);

describe("parseLoginForm / loginErrorMessage", () => {
  it("взима скритите полета и адреса на формата", () => {
    const form = parseLoginForm(signInPage);
    expect(form?.fields).toMatchObject({
      "$ACTION_REF_1": "",
      "$ACTION_KEY": "ka01a90ed6b59571b92de026da232b93c",
    });
    expect(JSON.parse(form!.fields["$ACTION_1:0"]).id).toBe("60163e504b5f4a00");
  });

  it("връща null, ако няма форма с парола", () => {
    expect(parseLoginForm("<html><body>сменихме сайта</body></html>")).toBeNull();
  });

  it("изважда съобщението за грешка от $ACTION_1:1", () => {
    expect(loginErrorMessage(failedSignInPage)).toBe("Невалиден имейл или парола.");
    expect(loginErrorMessage(signInPage)).toBeNull();
  });

  it("сглобява multipart тяло с всички полета", () => {
    const body = buildMultipart({ email: "e@x.bg", password: "p" }, "BOUND");
    expect(body).toContain('name="email"\r\n\r\ne@x.bg');
    expect(body).toContain('name="password"\r\n\r\np');
    expect(body.endsWith("--BOUND--\r\n")).toBe(true);
  });
});

describe("createLstarClient", () => {
  it("влиза през формата на новия сайт и не логва паролата", async () => {
    const logs: string[] = [];
    const requests: { url: string; method: string; body: string; contentType: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      requests.push({
        url,
        method: init.method ?? "GET",
        body: String(init.body ?? ""),
        contentType: headers.get("content-type") ?? "",
      });
      const setCookie = new Headers({ "set-cookie": "session=abc123; path=/" });
      if (url.endsWith("/sign-in") && (init.method ?? "GET") === "GET") {
        return new Response(signInPage, { status: 200 });
      }
      if (url.endsWith("/sign-in")) {
        return new Response("<html>ok</html>", { status: 200, headers: setCookie });
      }
      if (url.endsWith("/account")) {
        return new Response("<html>акаунт</html>", { status: 200, headers: setCookie });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const client = createLstarClient({
      email: "e@x.bg", password: "s3cret", fetchImpl, minIntervalMs: 0, log: (m) => logs.push(m),
    });
    await client.login();

    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(`${BASE}/sign-in`);
    expect(post?.contentType).toContain("multipart/form-data; boundary=");
    expect(post?.body).toContain('name="email"\r\n\r\ne@x.bg');
    expect(post?.body).toContain('name="password"\r\n\r\ns3cret');
    expect(post?.body).toContain('name="$ACTION_KEY"');
    expect(logs.join(" ")).not.toContain("s3cret");
    expect(logs.join(" ")).not.toContain("abc123");
  });

  it("съобщава за неуспешен вход с текста от сайта", async () => {
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/sign-in") && (init.method ?? "GET") === "GET") return new Response(signInPage);
      if (url.endsWith("/sign-in")) return new Response(failedSignInPage);
      // /account за нелогнат: 307 към /sign-in
      return new Response("", { status: 307, headers: { location: "/sign-in?next=%2Faccount" } });
    }) as unknown as typeof fetch;

    const client = createLstarClient({ email: "e", password: "p", fetchImpl, minIntervalMs: 0 });
    await expect(client.login()).rejects.toThrow(/Невалиден имейл или парола/);
  });

  it("не последва пренасочването на /account и разбира, че не е логнат", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 307, headers: { location: "/sign-in?next=%2Faccount" } })) as unknown as typeof fetch;
    const client = createLstarClient({ email: "e", password: "p", fetchImpl, minIntervalMs: 0 });
    expect(await client.isSignedIn()).toBe(false);
  });

  it("resolveUrl връща крайния адрес след 308", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.includes("route=product/category")) {
        return new Response(null, { status: 308, headers: { location: "/categories/originalni-aksesoari/originalni-keysove" } });
      }
      return new Response("ok");
    }) as unknown as typeof fetch;
    const client = createLstarClient({ email: "e", password: "p", fetchImpl, minIntervalMs: 0 });
    expect(await client.resolveUrl(`${BASE}/index.php?route=product/category&path=496_567`)).toBe(CASES);
  });

  it("отказва заявки извън lstarbg.com", async () => {
    const client = createLstarClient({ email: "e", password: "p", fetchImpl: (async () => new Response("")) as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(client.fetchText("https://evil.example/")).rejects.toThrow(/извън/);
  });
});
