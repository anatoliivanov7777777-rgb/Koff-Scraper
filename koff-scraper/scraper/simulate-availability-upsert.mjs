// OFFLINE contract check for the availability-safe upsert policy.
//
// Performs ZERO network calls and ZERO writes: it reads a raw Koff catalog
// artifact plus a CaseKing products snapshot from disk, runs the REAL
// buildCaseKingProducts() pipeline over them, applies the SAME create/skip
// decision the CaseKing availability guard applies, and reports what a live
// sync WOULD do.
//
// Usage:
//   node simulate-availability-upsert.mjs <raw-catalog.json> <products-snapshot>
//
// <raw-catalog.json>   the Koff raw artifact (array of raw products, each
//                      carrying a supplier `stock`).
// <products-snapshot>  the CaseKing products table, either a Convex export
//                      `products/documents.jsonl` or a backup .json whose
//                      `products` array holds the rows. Each row is read for
//                      `sourceKey`, `matchKey` and `isDeleted` only.
//
// Exit code is 0 when every hard requirement holds, 1 otherwise.

import fs from "node:fs";

// sync-caseking.mjs refuses to load without this variable. Nothing here ever
// constructs a Convex client or opens a socket - the value only satisfies
// that module-load guard so the real generation pipeline can be imported,
// exactly as the test suite does it.
process.env.CASEKING_CONVEX_URL ||= "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { buildCaseKingProducts, isSellable, resolveCategorySlug } = await import("./sync-caseking.mjs");

// Identical to buildMatchKey() in CaseKing convex/products.ts - upsertBatch
// derives it server-side, so a generated row does not carry one.
function buildMatchKey(name, brand, model, category) {
  return `${name.trim().toLowerCase()}|${brand.trim().toLowerCase()}|${model.trim().toLowerCase()}|${category.trim().toLowerCase()}`;
}

// Mirrors the availability guard in CaseKing convex/products.ts upsertBatch:
// a brand-new Koff row (one that matched no existing product) is created
// ONLY when the supplier reported a finite stock > 0. Zero stock, negative
// stock, and missing/unverified stock are all refused. Existing products are
// never subject to this - they always update, including to stock 0.
function mayCreateBrandNew(row) {
  if (row.source !== "koff-sync") return true;
  if (!row.sourceKey) return true; // restore/admin path - not a "brand-new Koff sourceKey"
  return typeof row.stock === "number" && Number.isFinite(row.stock) && row.stock > 0;
}

function loadJson(path) {
  const text = fs.readFileSync(path, "utf8");
  if (path.endsWith(".jsonl")) {
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.products)) return parsed.products;
  throw new Error(`Unrecognised snapshot shape in ${path}`);
}

function main() {
  const [rawPath, snapshotPath] = process.argv.slice(2);
  if (!rawPath || !snapshotPath) {
    console.error("Usage: node simulate-availability-upsert.mjs <raw-catalog.json> <products-snapshot>");
    process.exit(2);
  }

  const rawProducts = loadJson(rawPath);
  const existingRows = loadJson(snapshotPath).filter(r => !r.isDeleted);

  const missingStock = rawProducts.filter(r => !Number.isFinite(r.stock)).length;
  if (missingStock === rawProducts.length) {
    console.error(
      `\nABORT: not one of the ${rawProducts.length} raw products carries a numeric "stock" field.\n` +
      `This artifact predates supplier availability data, so an availability\n` +
      `simulation over it would be meaningless. Supply the fresh raw artifact.`
    );
    process.exit(1);
  }

  // --- existing catalog identity ---
  const existingBySourceKey = new Map();
  const duplicateExistingSourceKeys = new Set();
  for (const row of existingRows) {
    if (!row.sourceKey) continue;
    if (existingBySourceKey.has(row.sourceKey)) duplicateExistingSourceKeys.add(row.sourceKey);
    else existingBySourceKey.set(row.sourceKey, row);
  }
  // matchKey adoption only ever targets an existing row that has NO sourceKey
  // of its own (see upsertBatch) - a row that already carries a different
  // sourceKey is a distinct supplier product and is never merged into.
  const adoptableByMatchKey = new Map();
  for (const row of existingRows) {
    if (row.sourceKey || !row.matchKey) continue;
    if (!adoptableByMatchKey.has(row.matchKey)) adoptableByMatchKey.set(row.matchKey, row);
  }

  // --- run the REAL generation pipeline ---
  const generated = [];
  for (const raw of rawProducts) {
    const categorySlug = resolveCategorySlug(raw);
    if (!categorySlug) continue; // unmapped category - not onboarded, by design
    for (const row of buildCaseKingProducts(raw, categorySlug)) generated.push(row);
  }

  // --- simulate the upsert decision per generated row ---
  let existingUpdates = 0;
  let sellableCreates = 0;
  let zeroStockCreates = 0;
  let skippedUnsellable = 0;
  let duplicateCreates = 0;

  const generatedSourceKeyCounts = new Map();
  const claimedForCreate = new Set();
  const claimedAdoptions = new Set();

  for (const row of generated) {
    if (row.sourceKey) {
      generatedSourceKeyCounts.set(row.sourceKey, (generatedSourceKeyCounts.get(row.sourceKey) || 0) + 1);
    }

    let matched = row.sourceKey ? existingBySourceKey.get(row.sourceKey) : undefined;

    // A row already created earlier in this same run is "existing" for every
    // later row carrying the same sourceKey - that is an update, not a
    // second insert.
    if (!matched && row.sourceKey && claimedForCreate.has(row.sourceKey)) {
      existingUpdates++;
      continue;
    }

    if (!matched) {
      const matchKey = buildMatchKey(row.name, row.brand, row.model, row.category);
      const candidate = adoptableByMatchKey.get(matchKey);
      if (candidate && !claimedAdoptions.has(matchKey)) {
        claimedAdoptions.add(matchKey);
        matched = candidate;
      }
    }

    if (matched) {
      existingUpdates++;
      continue;
    }

    if (mayCreateBrandNew(row)) {
      sellableCreates++;
      if (row.sourceKey) {
        if (claimedForCreate.has(row.sourceKey)) duplicateCreates++;
        claimedForCreate.add(row.sourceKey);
      }
      if (!isSellable(row)) zeroStockCreates++; // must stay 0 - guard breach
    } else {
      skippedUnsellable++;
    }
  }

  const duplicateGeneratedSourceKeys = [...generatedSourceKeyCounts.entries()].filter(([, n]) => n > 1);

  // --- report ---
  const line = (label, value) => console.log(`${label.padEnd(34)} ${value}`);
  console.log("\n=== OFFLINE AVAILABILITY-UPSERT CONTRACT CHECK ===\n");
  line("raw products read:", rawProducts.length);
  line("raw with verified stock > 0:", rawProducts.filter(r => Number.isFinite(r.stock) && r.stock > 0).length);
  line("raw with stock = 0:", rawProducts.filter(r => r.stock === 0).length);
  line("raw with missing/unusable stock:", missingStock);
  console.log("");
  line("existing active products:", existingRows.length);
  line("existing with sourceKey:", existingBySourceKey.size);
  console.log("");
  line("generated rows:", generated.length);
  line("EXISTING UPDATES:", existingUpdates);
  line("SELLABLE CREATES:", sellableCreates);
  line("ZERO-STOCK CREATES:", zeroStockCreates);
  line("skipped (unsellable, not created):", skippedUnsellable);
  line("ACCIDENTAL DUPLICATE CREATES:", duplicateCreates);
  line("SOURCEKEY CONFLICTS:", duplicateExistingSourceKeys.size + duplicateGeneratedSourceKeys.length);
  console.log("");

  const failures = [];
  if (zeroStockCreates !== 0) failures.push(`zero-stock creates must be 0, got ${zeroStockCreates}`);
  if (duplicateCreates !== 0) failures.push(`duplicate creates must be 0, got ${duplicateCreates}`);
  if (duplicateExistingSourceKeys.size !== 0) failures.push(`duplicate existing sourceKeys must be 0, got ${duplicateExistingSourceKeys.size}`);
  if (duplicateGeneratedSourceKeys.length !== 0) failures.push(`duplicate generated sourceKeys must be 0, got ${duplicateGeneratedSourceKeys.length}`);

  if (failures.length) {
    console.log("RESULT: FAIL");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("RESULT: PASS (no writes performed - this is a read-only simulation)");
}

main();
