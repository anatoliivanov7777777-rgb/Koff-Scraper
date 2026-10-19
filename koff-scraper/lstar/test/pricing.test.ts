import { describe, expect, it } from "vitest";
import { priceFromLstar, toPricedCsv } from "../src/pricing.js";
// @ts-expect-error - споделеният модул е чист JS без типове
import { addVat, calcB2BPrice, calcB2CPrice } from "../../scraper/pricing.mjs";
import type { CsvRow } from "../src/core.js";

describe("priceFromLstar", () => {
  it("базата е цената на LStar както е - без x1.23", () => {
    for (const p of [1.2, 4.5, 9.5, 14.17, 16.38, 27.9, 55]) {
      const r = priceFromLstar(p)!;
      expect(r.base).toBe(p);
      expect(r.priceB2C).toBe(calcB2CPrice(p));
      expect(r.priceB2B).toBe(calcB2BPrice(p));
    }
  });

  it("дава по-ниска цена от Koff пътя за същата сума (там се добавя ДДС)", () => {
    expect(priceFromLstar(14.17)!.priceB2C).toBeLessThanOrEqual(calcB2CPrice(addVat(14.17)));
  });

  it("спазва правилата на магазина: B2C >= 9.99, B2B >= 1.99, всичко на .99, B2B <= B2C", () => {
    for (let p = 0.5; p <= 120; p += 0.37) {
      const r = priceFromLstar(Math.round(p * 100) / 100)!;
      expect(r.priceB2C).toBeGreaterThanOrEqual(9.99);
      expect(r.priceB2B).toBeGreaterThanOrEqual(1.99);
      expect(r.priceB2B).toBeLessThanOrEqual(r.priceB2C);
      expect(Math.round(r.priceB2C * 100) % 100).toBe(99);
      expect(Math.round(r.priceB2B * 100) % 100).toBe(99);
    }
  });

  it("без цена → без цена за магазина", () => {
    expect(priceFromLstar(null)).toBeNull();
    expect(priceFromLstar(0)).toBeNull();
  });
});

describe("toPricedCsv", () => {
  const row: CsvRow = { brand: "GUESS", name: "Кейс", sku: "X", ean: "", price_eur: "14.17", price_vat_included: "yes", note: "" };

  it("добавя B2B и B2C колони", () => {
    const lines = toPricedCsv([row, { ...row, price_eur: "" }]).replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toBe("brand;name;sku;ean;price_eur;price_vat_included;note;price_b2b_eur;price_b2c_eur");
    expect(lines[1].endsWith(`;${calcB2BPrice(14.17).toFixed(2)};${calcB2CPrice(14.17).toFixed(2)}`)).toBe(true);
    expect(lines[2].endsWith(";;")).toBe(true);
  });

  it("отказва, ако ДДС не е потвърдено", () => {
    expect(() => toPricedCsv([{ ...row, price_vat_included: "unconfirmed" }])).toThrow(/ДДС/);
  });
});
