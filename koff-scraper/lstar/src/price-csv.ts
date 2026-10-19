// Смята цените за CaseKing върху вече записан lstar-products.csv:
//   npx tsx src/price-csv.ts lstar-products.csv lstar-products-priced.csv
import { readFileSync, writeFileSync } from "node:fs";
import { CSV_HEADER, type CsvRow } from "./core.js";
import { toPricedCsv } from "./pricing.js";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ";") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function readCsv(text: string): CsvRow[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  if (lines[0] !== CSV_HEADER.join(";")) throw new Error("Неочакван заглавен ред");
  return lines.slice(1).map((line) => {
    const v = parseCsvLine(line);
    return Object.fromEntries(CSV_HEADER.map((k, i) => [k, v[i] ?? ""])) as unknown as CsvRow;
  });
}

const [input, output] = process.argv.slice(2);
if (input && output) {
  writeFileSync(output, toPricedCsv(readCsv(readFileSync(input, "utf8"))));
  console.log(`Готово: ${output}`);
}
