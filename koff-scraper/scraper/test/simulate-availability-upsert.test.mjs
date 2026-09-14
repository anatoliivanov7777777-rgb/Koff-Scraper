import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { buildCaseKingProducts, resolveCategorySlug } = await import("../sync-caseking.mjs");
const SCRIPT = new URL("../simulate-availability-upsert.mjs", import.meta.url).pathname.replace(/^\//, "");

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "koff-sim-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function rawProduct({ sku, id, name, stock, category = "Carbon Silicone" }) {
  return {
    sourceId: sku,
    sourceProductId: id,
    name,
    description: "",
    basePrice: 1.92,
    imageUrl: "https://cdn.koff.ro/img/x.jpg",
    category,
    manufacturer: "Techsuit",
    ...(stock === undefined ? {} : { stock }),
  };
}

function run(rawRows, existingRows) {
  const rawFile = tmpFile("raw.json", JSON.stringify(rawRows));
  const snapFile = tmpFile("snap.json", JSON.stringify(existingRows));
  let stdout;
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, rawFile, snapFile], { encoding: "utf8" });
  } catch (err) {
    stdout = (err.stdout || "") + (err.stderr || "");
    code = err.status;
  }
  const num = (label) => {
    const m = new RegExp(`${label}\\s+(-?\\d+)`).exec(stdout);
    return m ? Number(m[1]) : null;
  };
  return {
    stdout,
    code,
    existingUpdates: num("EXISTING UPDATES:"),
    sellableCreates: num("SELLABLE CREATES:"),
    zeroStockCreates: num("ZERO-STOCK CREATES:"),
    skipped: num("skipped \\(unsellable, not created\\):"),
    duplicateCreates: num("ACCIDENTAL DUPLICATE CREATES:"),
    sourceKeyConflicts: num("SOURCEKEY CONFLICTS:"),
  };
}

// Derive the sourceKeys the real pipeline produces, so fixtures describe
// "existing" rows exactly the way a live catalog would.
function generatedFor(raw) {
  const slug = resolveCategorySlug(raw);
  return buildCaseKingProducts(raw, slug);
}

test("a brand-new sellable product counts as a create, never an update", () => {
  const raw = rawProduct({ sku: "KF-NEW-1", id: 1, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 5 });
  const res = run([raw], []);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.existingUpdates, 0);
  assert.equal(res.sellableCreates, generatedFor(raw).length);
  assert.equal(res.zeroStockCreates, 0);
  assert.equal(res.skipped, 0);
});

test("a brand-new zero-stock product is skipped, not created", () => {
  const raw = rawProduct({ sku: "KF-OOS-1", id: 2, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 0 });
  const res = run([raw], []);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.sellableCreates, 0);
  assert.equal(res.zeroStockCreates, 0, "a skipped row must never be counted as a zero-stock create");
  assert.equal(res.skipped, generatedFor(raw).length);
});

test("a brand-new product with missing stock is skipped, not created", () => {
  const withStock = rawProduct({ sku: "KF-A", id: 3, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 4 });
  const noStock = rawProduct({ sku: "KF-B", id: 4, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 16 - Blue" });
  const res = run([withStock, noStock], []);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.sellableCreates, generatedFor(withStock).length);
  assert.equal(res.skipped, generatedFor(noStock).length);
});

test("an existing sourceKey counts as an update even at stock 0, and is never re-created", () => {
  const raw = rawProduct({ sku: "KF-EXIST", id: 5, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 0 });
  const existing = generatedFor(raw).map(row => ({
    _id: `p_${row.sourceKey}`, sourceKey: row.sourceKey, matchKey: "irrelevant", isDeleted: false,
  }));
  const res = run([raw], existing);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.existingUpdates, existing.length);
  assert.equal(res.sellableCreates, 0);
  assert.equal(res.zeroStockCreates, 0);
  assert.equal(res.skipped, 0, "an existing product must update, not be skipped, when it sells out");
});

test("soft-deleted existing rows are not treated as matches", () => {
  const raw = rawProduct({ sku: "KF-DEL", id: 6, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 3 });
  const deleted = generatedFor(raw).map(row => ({
    _id: `p_${row.sourceKey}`, sourceKey: row.sourceKey, matchKey: "x", isDeleted: true,
  }));
  const res = run([raw], deleted);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.existingUpdates, 0);
  assert.equal(res.sellableCreates, generatedFor(raw).length);
});

test("duplicate sourceKeys in the existing catalog are reported as conflicts and fail the check", () => {
  const raw = rawProduct({ sku: "KF-DUP", id: 7, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 3 });
  const [first] = generatedFor(raw);
  const existing = [
    { _id: "p_1", sourceKey: first.sourceKey, matchKey: "a", isDeleted: false },
    { _id: "p_2", sourceKey: first.sourceKey, matchKey: "b", isDeleted: false },
  ];
  const res = run([raw], existing);
  assert.equal(res.code, 1, "a sourceKey conflict must fail the contract check");
  assert.ok(res.sourceKeyConflicts >= 1);
});

test("a mixed batch splits cleanly into updates, creates and skips", () => {
  const existingRaw = rawProduct({ sku: "KF-M-EXIST", id: 10, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black", stock: 0 });
  const newSellable = rawProduct({ sku: "KF-M-NEW", id: 11, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 16 - Blue", stock: 6 });
  const newOos = rawProduct({ sku: "KF-M-OOS", id: 12, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 15 - Green", stock: 0 });

  const existing = generatedFor(existingRaw).map(row => ({
    _id: `p_${row.sourceKey}`, sourceKey: row.sourceKey, matchKey: "z", isDeleted: false,
  }));

  const res = run([existingRaw, newSellable, newOos], existing);
  assert.equal(res.code, 0, res.stdout);
  assert.equal(res.existingUpdates, generatedFor(existingRaw).length);
  assert.equal(res.sellableCreates, generatedFor(newSellable).length);
  assert.equal(res.skipped, generatedFor(newOos).length);
  assert.equal(res.zeroStockCreates, 0);
  assert.equal(res.duplicateCreates, 0);
  assert.equal(res.sourceKeyConflicts, 0);
});

test("an artifact with no stock data at all is refused rather than silently simulated", () => {
  const stockless = rawProduct({ sku: "KF-NOSTOCK", id: 20, name: "Techsuit - Carbon Silicone - Xiaomi Redmi 17 - Black" });
  const res = run([stockless], []);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /ABORT/);
});
