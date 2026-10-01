import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regression coverage for the Apple "iPhone -> Phone" continuation truncation
// defect (fixed in commit e6cae7b, brand-model.mjs:291-300).
//
// History this file pins down: three real Koff supplier titles listed the
// compatible devices as
//     "iPhone 18 Pro / Phone 17 Pro / Phone 17 / Phone 16 Pro"
// i.e. every continuation fragment after the first had dropped the leading
// "i" of "iPhone". The parser had no branch for a brand-less fragment of that
// shape, so each fragment was accepted verbatim as a model while inheriting
// brand "Apple" from the preceding fragment. That produced the bogus catalog
// identities Apple/Phone 16 Pro, Apple/Phone 17 and Apple/Phone 17 Pro, which
// then reached meta:addModel and products:upsertBatch.
//
// These tests make the defect fail loudly if it ever returns.
//
// No network, no Convex, no filesystem writes: only the pure exported
// functions are exercised. Importing sync-caseking.mjs does NOT run main()
// (it is guarded to run only when the file is executed directly).

process.env.CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";
// Safety belt: even if the ambient environment has LIVE=true, this file must
// never be able to drive a real synchronization.
process.env.LIVE = "false";
delete process.env.CASEKING_SYNC_SECRET;

const { buildCaseKingProducts, resolveCategorySlug } = await import("../sync-caseking.mjs");

// The invariant that must hold for ALL generated Apple model metadata.
// "Phone" followed by whitespace and a digit - the exact shape the defect took.
const MALFORMED_APPLE_MODEL_RE = /^Phone\s+\d/i;

// The three canonical identities the defect used to corrupt.
const REQUIRED_CANONICAL = ["iPhone 16 Pro", "iPhone 17", "iPhone 17 Pro"];

// Verbatim real raw catalog records (sourceId, id, name, category,
// manufacturer, basePrice and stock are exactly as captured from Koff).
const REAL_TRUNCATED_RECORDS = [
  {
    sourceId: "KF2368129",
    id: 386668,
    name: "3mk - HardGlass Screen Protector - iPhone 18 Pro / Phone 17 Pro / Phone 17 / Phone 16 Pro - Clear",
    description: "",
    basePrice: 1.02,
    imageUrl: "https://cdn.koff.ro/img/3/8/6/6/6/8/386668.jpg",
    category: "HardGlass",
    manufacturer: "3mk",
    stock: 20,
  },
  {
    sourceId: "KF2356859",
    id: 318856,
    name: "Spigen - Glas.tR EZ-FIT Pro HD (AGL10097) - iPhone 18 Pro / Phone 17 Pro / Phone 17 / Phone 16 Pro - Clear",
    description: "",
    basePrice: 2.1,
    imageUrl: "https://cdn.koff.ro/img/3/1/8/8/5/6/318856.jpg",
    category: "Glas.tR EZ-FIT",
    manufacturer: "Spigen",
    stock: 329,
  },
  {
    sourceId: "KF2338631",
    id: 185560,
    name: "Spigen - (2 pack) Glas.tR EZ-FIT (AGL07928) - iPhone 18 Pro / Phone 17 Pro / Phone 17 / Phone 16 Pro - Clear",
    description: "",
    basePrice: 3.2,
    imageUrl: "https://cdn.koff.ro/img/1/8/5/5/6/0/185560.jpg",
    category: "Glas.tR EZ-FIT",
    manufacturer: "Spigen",
    stock: 3619,
  },
];

// The whole-device list is expanded one row per compatible device.
const EXPECTED_DEVICE_MODELS = ["iPhone 18 Pro", "iPhone 17 Pro", "iPhone 17", "iPhone 16 Pro"];
const EXPECTED_CATEGORY_SLUG = "protektori-za-ekran";

const generate = (raw) => buildCaseKingProducts(raw, resolveCategorySlug(raw));

// --- 1. the real defect inputs now produce the four correct iPhone models ---

for (const raw of REAL_TRUNCATED_RECORDS) {
  test(`${raw.sourceId}: real truncated title expands to the four canonical iPhone models, never "Phone <n>"`, () => {
    const rows = generate(raw);

    assert.deepEqual(
      rows.map((r) => r.brand),
      ["Apple", "Apple", "Apple", "Apple"],
    );
    assert.deepEqual(
      rows.map((r) => r.model),
      EXPECTED_DEVICE_MODELS,
    );
    // meta:addModel / products:upsertBatch receive p.model verbatim - the
    // malformed shape must not exist anywhere in the generated metadata.
    for (const r of rows) {
      assert.doesNotMatch(r.model, MALFORMED_APPLE_MODEL_RE);
      assert.doesNotMatch(r.model, /^Phone /i);
    }
  });

  test(`${raw.sourceId}: the three previously-corrupted identities are exactly restored`, () => {
    const models = generate(raw).map((r) => r.model);

    for (const canonical of REQUIRED_CANONICAL) {
      assert.ok(models.includes(canonical), `expected generated model ${JSON.stringify(canonical)}`);
    }
    // and their malformed twins are gone
    for (const malformed of ["Phone 16 Pro", "Phone 17", "Phone 17 Pro"]) {
      assert.ok(!models.includes(malformed), `malformed model ${JSON.stringify(malformed)} must not be generated`);
    }
  });

  test(`${raw.sourceId}: stored identity (sourceKey) carries the canonical model, never ":Apple:Phone "`, () => {
    const rows = generate(raw);

    for (const canonical of REQUIRED_CANONICAL) {
      const row = rows.find((r) => r.model === canonical);
      assert.equal(row.sourceKey, `koff-sync:${raw.sourceId}:${EXPECTED_CATEGORY_SLUG}:Apple:${canonical}`);
    }
    for (const r of rows) {
      assert.doesNotMatch(r.sourceKey, /:Apple:Phone\s/);
    }
  });

  test(`${raw.sourceId}: the customer-facing name shows the canonical device label`, () => {
    const rows = generate(raw);

    for (const canonical of REQUIRED_CANONICAL) {
      const row = rows.find((r) => r.model === canonical);
      assert.ok(row.name.includes(`за ${canonical} `), `name must address ${canonical}: ${row.name}`);
    }
    for (const r of rows) {
      assert.doesNotMatch(r.name, / за Phone \d/);
    }
  });
}

// --- 2. sync-level metadata guard -------------------------------------------
// buildCaseKingProducts() is the exact producer of the rows the sync's
// metadata loop forwards to meta:addModel (sync-caseking.mjs:637-642: it
// passes `name: p.model` for every sellable row). Asserting on this array is
// therefore a direct guard on what may ever reach meta:addModel.

test("sync-level: no Apple model metadata produced for the real defect rows can reach meta:addModel as 'Phone <digit>'", () => {
  const metadata = REAL_TRUNCATED_RECORDS.flatMap((raw) =>
    generate(raw).map((r) => ({ brand: r.brand, model: r.model })),
  );

  assert.ok(metadata.length > 0, "expected generated metadata rows");
  const offending = metadata.filter((m) => m.brand === "Apple" && MALFORMED_APPLE_MODEL_RE.test(m.model));
  assert.deepEqual(offending, [], "no Apple model may be submitted to meta:addModel as 'Phone <digit>'");
});

test("sync-level: a model-level guard helper rejects the exact malformed shapes and accepts the canonical ones", () => {
  // Pins the semantics of the guard itself so a future edit to the pattern
  // cannot silently stop detecting the defect.
  for (const bad of ["Phone 16 Pro", "Phone 17", "Phone 17 Pro", "phone 15 pro", "PHONE 18"]) {
    assert.ok(MALFORMED_APPLE_MODEL_RE.test(bad), `${JSON.stringify(bad)} must be detected as malformed`);
  }
  for (const good of REQUIRED_CANONICAL) {
    assert.ok(!MALFORMED_APPLE_MODEL_RE.test(good), `${JSON.stringify(good)} must NOT be flagged`);
  }
});

// --- 3. the fix must not over-fire on legitimate "Phone" models -------------

test("legitimate non-Apple 'Phone' models are untouched and do not trip the guard", () => {
  // Nothing Phone (n) is a real, unrelated product line whose model text
  // legitimately starts with "Phone". The restored-i rule is scoped to a
  // proven Apple iPhone root and must never leak into this brand.
  const raw = {
    sourceId: "KF9000003",
    id: 333333,
    name: "Techsuit - PureFrost MagSafe - Nothing Phone (4b) - Frosted Black",
    description: "",
    basePrice: 5,
    imageUrl: "https://cdn.koff.ro/img/x.jpg",
    category: "PureFrost MagSafe",
    manufacturer: "Techsuit",
    stock: 5,
  };
  const rows = buildCaseKingProducts(raw, resolveCategorySlug(raw));

  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.notEqual(r.brand, "Apple");
    assert.doesNotMatch(r.model, MALFORMED_APPLE_MODEL_RE);
    assert.notEqual(r.model, "iPhone (4b)");
  }
});

// --- 4. real-data sweep (skipped when the raw catalog dump is absent) -------

const RAW_DUMP = new URL("../koff-products-raw.json", import.meta.url);
const hasRawDump = fs.existsSync(RAW_DUMP);

test(
  "real raw catalog: no Apple model anywhere in the captured catalog matches 'Phone <digit>'",
  { skip: hasRawDump ? false : "koff-products-raw.json is not present in this checkout" },
  () => {
    const records = JSON.parse(fs.readFileSync(RAW_DUMP, "utf8"));
    assert.ok(Array.isArray(records) && records.length > 1000, "expected the captured raw catalog");

    const violations = [];
    for (const raw of records) {
      let rows;
      try {
        rows = buildCaseKingProducts(raw, resolveCategorySlug(raw));
      } catch {
        continue; // rows the real sync would also refuse to build
      }
      for (const r of rows) {
        if (r.brand === "Apple" && MALFORMED_APPLE_MODEL_RE.test(r.model)) {
          violations.push(`${raw.sourceId} -> ${r.model}`);
        }
      }
    }

    assert.deepEqual(violations, []);
  },
);

test(
  "real raw catalog: the three source products that caused the defect are still the truncated supplier inputs",
  { skip: hasRawDump ? false : "koff-products-raw.json is not present in this checkout" },
  () => {
    const records = JSON.parse(fs.readFileSync(RAW_DUMP, "utf8"));

    for (const expected of REAL_TRUNCATED_RECORDS) {
      const found = records.find((r) => r.sourceId === expected.sourceId);
      assert.ok(found, `raw catalog must still contain ${expected.sourceId}`);
      // The supplier input really is malformed - this is what makes the fix
      // load-bearing rather than theoretical.
      assert.equal(found.name, expected.name);
      assert.match(found.name, /\/ Phone 17 Pro \/ Phone 17 \/ Phone 16 Pro /);
    }
  },
);
