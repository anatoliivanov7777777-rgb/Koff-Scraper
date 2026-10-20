// Пускане от командния ред / GitHub Actions:
//   LSTAR_EMAIL=... LSTAR_PASSWORD=... npm run scrape
// Незадължително:
//   LSTAR_PRICES_INCLUDE_VAT=yes|no|unconfirmed  (по подразбиране "yes" -
//     потвърдено от собственика на 2026-10-19: цените на LStar са с ДДС)
//   LSTAR_CATEGORY_PATHS=496_567,496_569,496_570
//   OUT_DIR=.                          (къде да се запишат CSV и докладът)
//
// Само чете от lstarbg.com: не пипа кошница, Convex или магазина.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLstarClient } from "./client.js";
import { DEFAULT_CATEGORY_PATHS, scrapeLstar, toCsv, type VatFlag } from "./core.js";
import { toPricedCsv } from "./pricing.js";

function vatFlag(raw: string | undefined): VatFlag {
  if (raw === undefined || raw === "") return "yes";
  return raw === "yes" || raw === "no" ? raw : "unconfirmed";
}

async function main() {
  const email = process.env.LSTAR_EMAIL ?? "";
  const password = process.env.LSTAR_PASSWORD ?? "";
  if (!email || !password) {
    console.error("Липсват LSTAR_EMAIL и/или LSTAR_PASSWORD (задават се като GitHub Secrets, не в кода).");
    process.exit(1);
  }
  const paths = process.env.LSTAR_CATEGORY_PATHS?.split(",").map((s) => s.trim()).filter(Boolean)
    ?? DEFAULT_CATEGORY_PATHS;
  const outDir = process.env.OUT_DIR || ".";

  const client = createLstarClient({ email, password, log: console.log });
  await client.login();
  const { rows, products, report } = await scrapeLstar({
    fetchText: client.fetchText,
    categoryPaths: paths,
    vatIncluded: vatFlag(process.env.LSTAR_PRICES_INCLUDE_VAT),
    log: console.log,
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "lstar-products.csv"), toCsv(rows));
  // Пълните данни за синхронизацията с магазина (снимки, съвместими телефони,
  // наличност). Без пароли и бисквитки - само това, което сайтът показва.
  writeFileSync(join(outDir, "lstar-products.json"), JSON.stringify(products, null, 1));
  if (report.vatIncluded === "yes") writeFileSync(join(outDir, "lstar-products-priced.csv"), toPricedCsv(rows));
  writeFileSync(join(outDir, "lstar-report.json"), JSON.stringify({ ...report, requests: client.getCounters() }, null, 2));
  console.log(`Готово: ${rows.length} продукта → ${join(outDir, "lstar-products.csv")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
