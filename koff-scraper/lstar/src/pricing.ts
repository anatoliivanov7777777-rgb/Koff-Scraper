// Цени за CaseKing от цените на LStar.
//
// Правилото е същото като на живия сайт (CASEKING PRICING v2 в
// ../scraper/pricing.mjs - един източник за всички доставчици), с една
// разлика, потвърдена от собственика на 2026-10-19:
//
//   цените на lstarbg.com са С ВКЛЮЧЕНО ДДС, затова базата е самата цена
//   на доставчика - БЕЗ addVat() / x1.23, който Koff ползва за нетните си цени.
//
// Надценките, долната граница 9.99 € (B2C), 1.99 € (B2B) и стълбата от
// цени, завършващи на .99, идват непроменени от pricing.mjs.

// @ts-expect-error - споделеният модул е чист JS без типове
import { calcB2BPrice, calcB2CPrice } from "../../scraper/pricing.mjs";

export interface CasekingPrices {
  base: number;
  priceB2B: number;
  priceB2C: number;
}

/** null при липсваща или невалидна цена - такъв продукт не се пуска в продажба. */
export function priceFromLstar(supplierPriceWithVat: number | null): CasekingPrices | null {
  if (supplierPriceWithVat === null || !Number.isFinite(supplierPriceWithVat) || supplierPriceWithVat <= 0) {
    return null;
  }
  const base = supplierPriceWithVat;
  return {
    base,
    priceB2B: (calcB2BPrice as (b: number) => number)(base),
    priceB2C: (calcB2CPrice as (b: number) => number)(base),
  };
}

// ---- Разширен CSV с цените за магазина ------------------------------------------
// Основният lstar-products.csv остава точно в договорения формат; този файл е
// същото + две колони, за да се види какво ще струва всеки продукт при нас.

import { CSV_HEADER, type CsvRow } from "./core.js";

export const PRICED_CSV_HEADER = [...CSV_HEADER, "price_b2b_eur", "price_b2c_eur"] as const;

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toPricedCsv(rows: CsvRow[]): string {
  const lines = [PRICED_CSV_HEADER.join(";")];
  for (const row of rows) {
    if (row.price_vat_included !== "yes") {
      throw new Error("Цени за магазина се смятат само когато е потвърдено, че цените на LStar са с ДДС");
    }
    const prices = priceFromLstar(row.price_eur === "" ? null : Number(row.price_eur));
    const values = [
      ...CSV_HEADER.map((k) => row[k]),
      prices ? prices.priceB2B.toFixed(2) : "",
      prices ? prices.priceB2C.toFixed(2) : "",
    ];
    lines.push(values.map(csvField).join(";"));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
