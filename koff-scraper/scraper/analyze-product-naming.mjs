// Phase E — READ-ONLY full-catalog naming/identity quality analysis.
//
// Reads the local koff-products-raw.json (real, already-scraped catalog)
// and runs it through the REAL current naming pipeline
// (resolveCategorySlug + buildCaseKingProducts from sync-caseking.mjs)
// to quantify naming/parser/slug/identity quality BEFORE any catalog
// write. Makes ZERO network calls, ZERO Convex calls, ZERO mutations,
// and never invokes sync-caseking.mjs's main()/live sync path. Contains
// no credentials.
//
// Usage: node analyze-product-naming.mjs [path-to-koff-products-raw.json]
//
// Writes analysis-output/phase-e-naming-report.json and .md next to this
// script. Those reports (and the raw catalog itself) are LOCAL ANALYSIS
// OUTPUT ONLY - see .git/info/exclude - never committed/pushed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProductName } from "./parse-names.mjs";
import { resolvePublicMaker } from "./public-maker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// sync-caseking.mjs validates CASEKING_CONVEX_URL at module load time
// (even though we only ever call its pure functions) - same fixture
// value already used by the existing test suite. This script never
// calls main()/live sync, so no other env var matters.
process.env.CASEKING_CONVEX_URL ||= "https://elated-butterfly-122.eu-west-1.convex.cloud";
const { resolveCategorySlug, buildCaseKingProducts } = await import("./sync-caseking.mjs");

// ---------------------------------------------------------------------
// Exact read-only mirror of CaseKing's convex/products.ts buildSlug() -
// for SIMULATION only. CaseKing itself is never touched/imported (it's
// a separate repo/TypeScript runtime) - this is a verbatim port so the
// slug-collision analysis reflects what CaseKing would actually compute
// for these exact (name, model) pairs.
// ---------------------------------------------------------------------
const BG_TRANSLIT_MAP = {
  "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh",
  "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n",
  "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
  "х": "h", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sht", "ъ": "a", "ь": "y",
  "ю": "yu", "я": "ya",
  "А": "A", "Б": "B", "В": "V", "Г": "G", "Д": "D", "Е": "E", "Ж": "Zh",
  "З": "Z", "И": "I", "Й": "Y", "К": "K", "Л": "L", "М": "M", "Н": "N",
  "О": "O", "П": "P", "Р": "R", "С": "S", "Т": "T", "У": "U", "Ф": "F",
  "Х": "H", "Ц": "Ts", "Ч": "Ch", "Ш": "Sh", "Щ": "Sht", "Ъ": "A", "Ь": "Y",
  "Ю": "Yu", "Я": "Ya",
};

export function simulateCaseKingSlug(name, model) {
  const combined = `${name} ${model || ""}`.toLowerCase();
  const transliterated = combined.split("").map((ch) => BG_TRANSLIT_MAP[ch] || ch).join("");
  return transliterated
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function slugifyFragment(text) {
  return simulateCaseKingSlug(text, "");
}

// ---------------------------------------------------------------------
// small stats helpers
// ---------------------------------------------------------------------
function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.ceil((p / 100) * sortedArr.length) - 1);
  return sortedArr[Math.max(0, idx)];
}
function lengthStats(lengths) {
  const sorted = [...lengths].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? 0,
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}
function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}
function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---------------------------------------------------------------------
// load raw catalog
// ---------------------------------------------------------------------
const rawPath = process.argv[2] || path.join(__dirname, "koff-products-raw.json");
if (!fs.existsSync(rawPath)) {
  console.error(`Raw catalog not found at ${rawPath}`);
  process.exit(1);
}
const rawStat = fs.statSync(rawPath);
const rawProducts = JSON.parse(fs.readFileSync(rawPath, "utf8"));
if (!Array.isArray(rawProducts)) {
  console.error("Raw catalog is not a JSON array");
  process.exit(1);
}

// ---------------------------------------------------------------------
// pass 1: category resolution + row generation (the REAL pipeline)
// ---------------------------------------------------------------------
const unmappedCategoryCounts = new Map();
const mappedCategoryCounts = new Map(); // generated categorySlug -> raw product count (unique raw contributing)
const categoryGeneratedRowCounts = new Map(); // generated categorySlug -> row count

const rows = []; // { row, raw, categorySlug (the ORIGINAL slug passed to buildCaseKingProducts) }
let mappedRawCount = 0;
let unmappedRawCount = 0;

for (const raw of rawProducts) {
  const slug = resolveCategorySlug(raw);
  if (!slug) {
    unmappedRawCount++;
    bump(unmappedCategoryCounts, raw.category || "(missing)");
    continue;
  }
  mappedRawCount++;
  const generated = buildCaseKingProducts(raw, slug);
  const touchedCats = new Set();
  for (const row of generated) {
    rows.push({ row, raw, categorySlug: slug });
    bump(categoryGeneratedRowCounts, row.category);
    touchedCats.add(row.category);
  }
  for (const cat of touchedCats) bump(mappedCategoryCounts, cat);
}

// ---------------------------------------------------------------------
// Techsuit + public maker audit
// ---------------------------------------------------------------------
let rawManufacturerTechsuit = 0;
let rawFallbackTechsuitFromName = 0;
for (const raw of rawProducts) {
  const resolution = resolvePublicMaker({ manufacturer: raw.manufacturer, rawName: raw.name });
  const manuNorm = (raw.manufacturer || "").trim().toLowerCase();
  if (manuNorm === "techsuit") rawManufacturerTechsuit++;
  else if (resolution.rebranded) rawFallbackTechsuitFromName++;
}

let rowsPublicMakerCaseKing = 0;
let techsuitAccessoryRows = 0;
let techsuitAccessorySourceKeyOk = 0;
let techsuitAccessorySourceKeyBROKEN = 0;
let techsuitPhoneRows = 0;
let techsuitPhoneBrandCorrect = 0;
let techsuitRowsMissingSourceProductId = 0;
let rowsWithPublicMaker = 0;
let rowsWithoutPublicMaker = 0;
const missingPublicMakerByCategory = new Map();
const missingPublicMakerByManufacturer = new Map();

for (const { row, raw } of rows) {
  if (row.publicMaker !== undefined) {
    rowsWithPublicMaker++;
  } else {
    rowsWithoutPublicMaker++;
    bump(missingPublicMakerByCategory, row.category);
    bump(missingPublicMakerByManufacturer, raw.manufacturer || "(missing)");
  }

  if (row.publicMaker === "CaseKing") {
    rowsPublicMakerCaseKing++;
    if (row.sourceProductId === undefined) techsuitRowsMissingSourceProductId++;

    if (row.brand === "CaseKing") {
      techsuitAccessoryRows++;
      if (/techsuit/i.test(row.sourceKey)) techsuitAccessorySourceKeyOk++;
      else techsuitAccessorySourceKeyBROKEN++;
    } else {
      techsuitPhoneRows++;
      if (row.brand !== "CaseKing" && row.brand) techsuitPhoneBrandCorrect++;
    }
  }
}

// ---------------------------------------------------------------------
// naming warnings
// ---------------------------------------------------------------------
let rowsWithWarnings = 0;
const warningsByType = new Map();
const warningsByCategory = new Map();
const unknownColorCounts = new Map(); // color value -> count
const unknownColorExamples = new Map(); // color value -> [example names]
let unknownColorWarnings = 0;
let genericFallbackWarnings = 0;
let otherWarnings = 0;

for (const { row } of rows) {
  const warnings = row._namingWarnings || [];
  if (warnings.length > 0) rowsWithWarnings++;
  for (const w of warnings) {
    bump(warningsByCategory, row.category);
    const colorMatch = w.match(/^Unrecognized color "(.*)" preserved without translation$/);
    if (colorMatch) {
      unknownColorWarnings++;
      bump(warningsByType, "unknown/untranslated color");
      const colorVal = colorMatch[1];
      bump(unknownColorCounts, colorVal);
      if (!unknownColorExamples.has(colorVal)) unknownColorExamples.set(colorVal, []);
      const list = unknownColorExamples.get(colorVal);
      if (list.length < 3) list.push(row.name);
    } else if (/^(Ambiguous category|Unknown or unmapped categorySlug)/.test(w)) {
      genericFallbackWarnings++;
      bump(warningsByType, "generic/fallback product type");
    } else {
      otherWarnings++;
      bump(warningsByType, `other: ${w.slice(0, 60)}`);
    }
  }
}

// ---------------------------------------------------------------------
// parser quality: two-part productLine===color duplication
// ---------------------------------------------------------------------
const twoPartQuirkRawIds = new Set();
const twoPartQuirkExamples = [];
let twoPartQuirkGeneratedRows = 0;

// product-line self-duplication ("X - X")
const dupLineQuirkRawIds = new Set();
const dupLineQuirkExamples = [];
let dupLineQuirkGeneratedRows = 0;

for (const raw of rawProducts) {
  const parsed = parseProductName(raw.name || "", raw.manufacturer);
  const line = (parsed.productLine || "").trim();
  const color = (parsed.color || "").trim();
  if (line && color && line === color) {
    twoPartQuirkRawIds.add(raw.sourceId);
    if (twoPartQuirkExamples.length < 30) {
      twoPartQuirkExamples.push({ sourceId: raw.sourceId, rawName: raw.name, productLine: line, color });
    }
  }
  const selfDupMatch = /^(.+) - \1$/.exec(line);
  if (selfDupMatch) {
    dupLineQuirkRawIds.add(raw.sourceId);
    if (dupLineQuirkExamples.length < 30) {
      dupLineQuirkExamples.push({ sourceId: raw.sourceId, rawName: raw.name, productLine: line });
    }
  }
}
for (const { row, raw } of rows) {
  if (twoPartQuirkRawIds.has(raw.sourceId)) twoPartQuirkGeneratedRows++;
  if (dupLineQuirkRawIds.has(raw.sourceId)) dupLineQuirkGeneratedRows++;
}

// ---------------------------------------------------------------------
// other formatting anomalies
// ---------------------------------------------------------------------
const anomalies = {
  duplicatePublicMaker: [],
  doubledPunctuation: [],
  excessiveWhitespace: [],
  blankName: [],
  literalUndefinedNull: [],
  productTypeRepeatedTwice: [],
};
for (const { row } of rows) {
  const name = row.name || "";
  if (row.publicMaker) {
    const escaped = row.publicMaker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const occurrences = (name.match(new RegExp(escaped, "g")) || []).length;
    if (occurrences >= 2 && anomalies.duplicatePublicMaker.length < 30) {
      anomalies.duplicatePublicMaker.push({ name, sourceKey: row.sourceKey });
    }
  }
  if (/[,;:]{2,}|–\s*–|-{2,}/.test(name) && anomalies.doubledPunctuation.length < 30) {
    anomalies.doubledPunctuation.push({ name, sourceKey: row.sourceKey });
  }
  if (/ {2,}/.test(name) && anomalies.excessiveWhitespace.length < 30) {
    anomalies.excessiveWhitespace.push({ name, sourceKey: row.sourceKey });
  }
  if (!name.trim() && anomalies.blankName.length < 30) {
    anomalies.blankName.push({ sourceKey: row.sourceKey });
  }
  if (/\b(undefined|null)\b/i.test(name) && anomalies.literalUndefinedNull.length < 30) {
    anomalies.literalUndefinedNull.push({ name, sourceKey: row.sourceKey });
  }
  const typeMatch = name.match(/^(\S+(?:\s\S+)?)\s+\1\b/);
  if (typeMatch && anomalies.productTypeRepeatedTwice.length < 30) {
    anomalies.productTypeRepeatedTwice.push({ name, sourceKey: row.sourceKey });
  }
}

// ---------------------------------------------------------------------
// device label quality
// ---------------------------------------------------------------------
let appleWithBrand = 0, appleExamples = [];
let samsungWithGalaxy = 0, samsungWithoutGalaxy = 0, samsungExamples = [];
let motoUppercase = 0, motoExamples = [];
const watchExamples = [];
const distinctDeviceBrands = new Set();

for (const { row } of rows) {
  if (row._isWatch || row.category === "aksesoari_chasovnici") {
    if (watchExamples.length < 20) watchExamples.push(row.name);
  }
  if (row._isAccessory) continue; // brand is accessory maker, not a device brand here
  distinctDeviceBrands.add(row.brand);
  if (row.brand === "Apple") {
    if (/Apple iPhone/.test(row.name)) {
      appleWithBrand++;
      if (appleExamples.length < 10) appleExamples.push(row.name);
    }
  } else if (row.brand === "Samsung") {
    if (/Galaxy/.test(row.model)) samsungWithGalaxy++;
    else samsungWithoutGalaxy++;
    if (samsungExamples.length < 10) samsungExamples.push(row.name);
  } else if (row.brand === "MOTO") {
    motoUppercase++;
    if (motoExamples.length < 10) motoExamples.push(row.name);
  }
}

// ---------------------------------------------------------------------
// name collisions
// ---------------------------------------------------------------------
const byName = new Map();
for (const { row } of rows) {
  if (!byName.has(row.name)) byName.set(row.name, []);
  byName.get(row.name).push(row);
}
const collisionGroups = [...byName.entries()].filter(([, list]) => list.length > 1);
let collisionRowsInvolved = 0;
const classifiedGroups = collisionGroups.map(([name, list]) => {
  collisionRowsInvolved += list.length;
  const sourceKeys = new Set(list.map((r) => r.sourceKey));
  const sourceProductIds = new Set(list.map((r) => r.sourceProductId).filter((v) => v !== undefined));
  const colors = new Set(list.map((r) => {
    const m = /–\s*(.+)$/.exec(r.name);
    return m ? m[1] : "(none)";
  }));
  let classification = "BENIGN";
  // Same generic name (type+maker only, no device/color) across many
  // unrelated accessory SKUs is expected/benign - it's not a variant
  // collapse, it's just weak/short source data.
  const isGeneric = !/за /.test(name) && !/–/.test(name);
  if (!isGeneric && sourceKeys.size > 1) classification = "SUSPICIOUS";
  if (colors.size > 1 && !isGeneric) classification = "DANGEROUS"; // same name, different actual colors -> a real variant got collapsed
  return {
    name, count: list.length, sourceKeyCount: sourceKeys.size,
    sourceProductIdCount: sourceProductIds.size, distinctColorCount: colors.size,
    classification,
    sampleSourceKeys: [...sourceKeys].slice(0, 5),
  };
});
classifiedGroups.sort((a, b) => b.count - a.count);
const dangerousGroups = classifiedGroups.filter((g) => g.classification === "DANGEROUS");

// ---------------------------------------------------------------------
// source identity audit
// ---------------------------------------------------------------------
const bySourceKey = new Map();
for (const { row } of rows) {
  if (!bySourceKey.has(row.sourceKey)) bySourceKey.set(row.sourceKey, []);
  bySourceKey.get(row.sourceKey).push(row);
}
const duplicateSourceKeyGroups = [...bySourceKey.entries()].filter(([, list]) => list.length > 1);
const sourceKeyToProductIds = new Map();
for (const [key, list] of bySourceKey.entries()) {
  const ids = new Set(list.map((r) => r.sourceProductId).filter((v) => v !== undefined));
  if (ids.size > 1) sourceKeyToProductIds.set(key, [...ids]);
}
const rowsMissingSourceProductId = rows.filter(({ row }) => row.sourceProductId === undefined).length;

const bySourceProductId = new Map();
for (const { row } of rows) {
  if (row.sourceProductId === undefined) continue;
  if (!bySourceProductId.has(row.sourceProductId)) bySourceProductId.set(row.sourceProductId, []);
  bySourceProductId.get(row.sourceProductId).push(row);
}
const sourceProductIdSharedByMultipleRows = [...bySourceProductId.entries()].filter(([, l]) => l.length > 1).length;

// ---------------------------------------------------------------------
// slug simulation
// ---------------------------------------------------------------------
const slugStatsRows = [];
const bySlug = new Map();
let emptySlugCount = 0;
for (const { row } of rows) {
  const slug = simulateCaseKingSlug(row.name, row.model);
  slugStatsRows.push({ slug, row });
  if (!bySlug.has(slug)) bySlug.set(slug, []);
  bySlug.get(slug).push(row);
  if (!slug) emptySlugCount++;
}
const slugCollisionGroups = [...bySlug.entries()].filter(([slug, list]) => slug && list.length > 1);
let slugCollisionRows = 0;
let slugCollisionsAcrossDifferentSourceKeys = 0;
for (const [, list] of slugCollisionGroups) {
  slugCollisionRows += list.length;
  if (new Set(list.map((r) => r.sourceKey)).size > 1) slugCollisionsAcrossDifferentSourceKeys++;
}

let duplicateModelSlugCount = 0;
const duplicateModelSlugExamples = [];
for (const { slug, row } of slugStatsRows) {
  if (!row.model || row.model === "Всички модели") continue;
  const modelFragment = slugifyFragment(row.model);
  if (!modelFragment) continue;
  const escaped = modelFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const occurrences = (slug.match(new RegExp(escaped, "g")) || []).length;
  if (occurrences >= 2) {
    duplicateModelSlugCount++;
    if (duplicateModelSlugExamples.length < 30) {
      duplicateModelSlugExamples.push({ name: row.name, model: row.model, slug });
    }
  }
}

const slugLengths = slugStatsRows.map((s) => s.slug.length);
const slugLenStats = lengthStats(slugLengths);
const longestSlugs = [...slugStatsRows]
  .sort((a, b) => b.slug.length - a.slug.length)
  .slice(0, 30)
  .map((s) => ({ length: s.slug.length, slug: s.slug, name: s.row.name }));

// ---------------------------------------------------------------------
// name length / SEO quality
// ---------------------------------------------------------------------
const nameLengths = rows.map(({ row }) => row.name.length);
const nameLenStats = lengthStats(nameLengths);
const longestNames = [...rows]
  .sort((a, b) => b.row.name.length - a.row.name.length)
  .slice(0, 50)
  .map(({ row }) => ({ length: row.name.length, name: row.name }));

const weakNames = [];
for (const { row, categorySlug } of rows) {
  const isDeviceCategory = !["zaryadni-ustroystva", "bezzhichni-zaryadni", "kabeli-za-zaryadane",
    "vanshni-baterii", "headphones", "memory_cards", "audio_cables", "postavki-za-byuro",
    "selfi-stikove", "popsoket-i-vrazki", "aksesoari-za-avtomobili"].includes(categorySlug);
  const hasDeviceClause = / за /.test(row.name);
  if (isDeviceCategory && row.model === "Всички модели" && weakNames.length < 100) {
    weakNames.push({ reason: "device-oriented category with unresolved device", name: row.name });
  } else if (isDeviceCategory && !hasDeviceClause && row.model !== "Всички модели" && weakNames.length < 100) {
    weakNames.push({ reason: "device category but name has no device clause (unexpected)", name: row.name });
  }
}

// ---------------------------------------------------------------------
// before/after samples (60+)
// ---------------------------------------------------------------------
const sampleTargets = [
  { label: "Techsuit case", test: ({ raw, row }) => /techsuit/i.test(raw.manufacturer || "") && row.category === "keysove-i-kalufi" },
  { label: "Techsuit screen protector", test: ({ raw, row }) => /techsuit/i.test(raw.manufacturer || "") && row.category === "protektori-za-ekran" },
  { label: "Techsuit camera protector", test: ({ raw, row }) => /techsuit/i.test(raw.manufacturer || "") && /Протектор за камера/.test(row.name) },
  { label: "Techsuit accessory", test: ({ raw, row }) => /techsuit/i.test(raw.manufacturer || "") && row.brand === "CaseKing" },
  { label: "Spigen", test: ({ raw }) => /spigen/i.test(raw.manufacturer || "") },
  { label: "Baseus", test: ({ raw }) => /baseus/i.test(raw.manufacturer || "") },
  { label: "Mcdodo", test: ({ raw }) => /mcdodo/i.test(raw.manufacturer || "") },
  { label: "Apple-compatible", test: ({ row }) => row.brand === "Apple" },
  { label: "Samsung-compatible", test: ({ row }) => row.brand === "Samsung" },
  { label: "Xiaomi-compatible", test: ({ row }) => row.brand === "Xiaomi" },
  { label: "Motorola-compatible", test: ({ row }) => row.brand === "MOTO" },
  { label: "watch", test: ({ row }) => row.category === "aksesoari_chasovnici" },
  { label: "cable", test: ({ row }) => row.category === "kabeli-za-zaryadane" },
  { label: "charger", test: ({ row }) => row.category === "zaryadni-ustroystva" },
  { label: "powerbank", test: ({ row }) => row.category === "vanshni-baterii" },
  { label: "car charger", test: ({ row }) => /Зарядно за кола/.test(row.name) },
  { label: "car holder", test: ({ row }) => /^Стойка за кола/.test(row.name) },
  { label: "wireless car holder", test: ({ row }) => /безжично зареждане за кола/.test(row.name) },
  { label: "hydrogel", test: ({ row }) => row.category === "hydrogel_film" },
  { label: "memory card", test: ({ row }) => /^Карта памет/.test(row.name) },
  { label: "USB memory", test: ({ row }) => /^USB памет/.test(row.name) },
  { label: "card reader", test: ({ row }) => /^Четец за карти/.test(row.name) },
  { label: "audio", test: ({ row }) => row.category === "audio_cables" },
  { label: "unknown color", test: ({ row }) => (row._namingWarnings || []).some((w) => w.startsWith("Unrecognized color")) },
  { label: "generic type warning", test: ({ row }) => (row._namingWarnings || []).some((w) => /^(Ambiguous category|Unknown or unmapped)/.test(w)) },
  { label: "parser anomaly candidate", test: ({ raw }) => twoPartQuirkRawIds.has(raw.sourceId) || dupLineQuirkRawIds.has(raw.sourceId) },
];

const samples = [];
for (const target of sampleTargets) {
  const found = rows.filter(target.test).slice(0, 3);
  for (const { row, raw } of found) {
    samples.push({
      group: target.label,
      rawName: raw.name,
      newName: row.name,
      rawCategory: raw.category,
      manufacturer: raw.manufacturer,
      publicMaker: row.publicMaker,
      brand: row.brand,
      model: row.model,
      sourceKey: row.sourceKey,
      sourceProductId: row.sourceProductId,
      warnings: row._namingWarnings || [],
    });
  }
}

// ---------------------------------------------------------------------
// assemble report
// ---------------------------------------------------------------------
const report = {
  meta: {
    rawArtifactPath: rawPath,
    rawArtifactMtime: rawStat.mtime.toISOString(),
    rawArtifactSize: rawStat.size,
    generatedAt: new Date().toISOString(),
  },
  counts: {
    rawProducts: rawProducts.length,
    mappedRawProducts: mappedRawCount,
    unmappedRawProducts: unmappedRawCount,
    generatedRows: rows.length,
    topUnmappedCategories: topN(unmappedCategoryCounts, 30),
    byCategory: [...new Set([...mappedCategoryCounts.keys(), ...categoryGeneratedRowCounts.keys()])]
      .map((cat) => ({
        category: cat,
        mappedRawProducts: mappedCategoryCounts.get(cat) || 0,
        generatedRows: categoryGeneratedRowCounts.get(cat) || 0,
      }))
      .sort((a, b) => b.generatedRows - a.generatedRows),
  },
  techsuit: {
    rawManufacturerExactTechsuit: rawManufacturerTechsuit,
    fallbackTechsuitFromLeadingNameToken: rawFallbackTechsuitFromName,
    generatedRowsWithPublicMakerCaseKing: rowsPublicMakerCaseKing,
    techsuitAccessoryRows,
    techsuitAccessorySourceKeyOk,
    techsuitAccessorySourceKeyBROKEN,
    techsuitPhoneRows,
    techsuitPhoneBrandCorrect,
    techsuitRowsMissingSourceProductId,
  },
  publicMaker: {
    rowsWithPublicMaker,
    rowsWithoutPublicMaker,
    percentMissing: rows.length ? +((rowsWithoutPublicMaker / rows.length) * 100).toFixed(2) : 0,
    topCategoriesMissing: topN(missingPublicMakerByCategory, 15),
    topManufacturersMissing: topN(missingPublicMakerByManufacturer, 15),
  },
  warnings: {
    rowsWithWarnings,
    warningRatePercent: rows.length ? +((rowsWithWarnings / rows.length) * 100).toFixed(2) : 0,
    unknownColorWarnings,
    genericFallbackWarnings,
    otherWarnings,
    byType: topN(warningsByType, 40),
    byCategory: topN(warningsByCategory, 20),
    top50UnknownColors: topN(unknownColorCounts, 50).map(([color, count]) => ({
      color, count, examples: unknownColorExamples.get(color) || [],
    })),
  },
  parserQuality: {
    twoPartQuirk: {
      rawProductCount: twoPartQuirkRawIds.size,
      generatedRowCount: twoPartQuirkGeneratedRows,
      percentOfRaw: rawProducts.length ? +((twoPartQuirkRawIds.size / rawProducts.length) * 100).toFixed(2) : 0,
      examples: twoPartQuirkExamples,
    },
    productLineSelfDuplication: {
      rawProductCount: dupLineQuirkRawIds.size,
      generatedRowCount: dupLineQuirkGeneratedRows,
      percentOfRaw: rawProducts.length ? +((dupLineQuirkRawIds.size / rawProducts.length) * 100).toFixed(2) : 0,
      examples: dupLineQuirkExamples,
    },
    otherAnomalies: {
      duplicatePublicMakerCount: anomalies.duplicatePublicMaker.length,
      doubledPunctuationCount: anomalies.doubledPunctuation.length,
      excessiveWhitespaceCount: anomalies.excessiveWhitespace.length,
      blankNameCount: anomalies.blankName.length,
      literalUndefinedNullCount: anomalies.literalUndefinedNull.length,
      productTypeRepeatedTwiceCount: anomalies.productTypeRepeatedTwice.length,
      examples: anomalies,
    },
  },
  deviceLabels: {
    apple: { withAppleBrandPrefixCount: appleWithBrand, examples: appleExamples },
    samsung: { withGalaxy: samsungWithGalaxy, withoutGalaxy: samsungWithoutGalaxy, examples: samsungExamples },
    motorola: { uppercaseMotoCount: motoUppercase, examples: motoExamples },
    watchExamples,
    distinctDeviceBrands: [...distinctDeviceBrands].sort(),
  },
  nameCollisions: {
    collisionGroupCount: collisionGroups.length,
    rowsInvolved: collisionRowsInvolved,
    collisionRatePercent: rows.length ? +((collisionRowsInvolved / rows.length) * 100).toFixed(2) : 0,
    dangerousGroupCount: dangerousGroups.length,
    worst30Groups: classifiedGroups.slice(0, 30),
  },
  sourceIdentity: {
    duplicateSourceKeyGroupCount: duplicateSourceKeyGroups.length,
    sourceKeysWithMultipleSourceProductIds: sourceKeyToProductIds.size,
    rowsMissingSourceProductId,
    techsuitRowsMissingSourceProductId,
    sourceProductIdsSharedByMultipleRows: sourceProductIdSharedByMultipleRows,
  },
  slugSimulation: {
    collisionGroupCount: slugCollisionGroups.length,
    collisionRows: slugCollisionRows,
    collisionsAcrossDifferentSourceKeys: slugCollisionsAcrossDifferentSourceKeys,
    duplicateModelSlugCount,
    duplicateModelSlugPercent: rows.length ? +((duplicateModelSlugCount / rows.length) * 100).toFixed(2) : 0,
    duplicateModelSlugExamples,
    emptySlugCount,
    lengthStats: slugLenStats,
    countOver100: slugLengths.filter((l) => l > 100).length,
    countOver120: slugLengths.filter((l) => l > 120).length,
    countOver150: slugLengths.filter((l) => l > 150).length,
    countOver200: slugLengths.filter((l) => l > 200).length,
    longest30: longestSlugs,
  },
  nameLength: {
    lengthStats: nameLenStats,
    countOver80: nameLengths.filter((l) => l > 80).length,
    countOver100: nameLengths.filter((l) => l > 100).length,
    countOver120: nameLengths.filter((l) => l > 120).length,
    countOver150: nameLengths.filter((l) => l > 150).length,
    longest50: longestNames,
    weakNameExamples: weakNames.slice(0, 50),
  },
  samples,
};

// ---------------------------------------------------------------------
// write reports
// ---------------------------------------------------------------------
const outDir = path.join(__dirname, "analysis-output");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "phase-e-naming-report.json"), JSON.stringify(report, null, 2));

const md = [];
md.push("# Phase E — Full-Catalog Naming Analysis");
md.push("");
md.push(`Raw artifact: \`${rawPath}\` (${rawStat.size} bytes, modified ${rawStat.mtime.toISOString()})`);
md.push("");
md.push("## Core counts");
md.push(`- Raw products: ${report.counts.rawProducts}`);
md.push(`- Mapped: ${report.counts.mappedRawProducts}`);
md.push(`- Unmapped: ${report.counts.unmappedRawProducts}`);
md.push(`- Generated rows: ${report.counts.generatedRows}`);
md.push("");
md.push("## Techsuit identity");
md.push("```json");
md.push(JSON.stringify(report.techsuit, null, 2));
md.push("```");
md.push("");
md.push("## Public maker");
md.push("```json");
md.push(JSON.stringify(report.publicMaker, null, 2));
md.push("```");
md.push("");
md.push("## Warnings");
md.push("```json");
md.push(JSON.stringify({ ...report.warnings, top50UnknownColors: `${report.warnings.top50UnknownColors.length} entries (see JSON)` }, null, 2));
md.push("```");
md.push("");
md.push("## Parser quality");
md.push("```json");
md.push(JSON.stringify({
  twoPartQuirk: { ...report.parserQuality.twoPartQuirk, examples: `${report.parserQuality.twoPartQuirk.examples.length} (see JSON)` },
  productLineSelfDuplication: { ...report.parserQuality.productLineSelfDuplication, examples: `${report.parserQuality.productLineSelfDuplication.examples.length} (see JSON)` },
  otherAnomalies: {
    duplicatePublicMakerCount: report.parserQuality.otherAnomalies.duplicatePublicMakerCount,
    doubledPunctuationCount: report.parserQuality.otherAnomalies.doubledPunctuationCount,
    excessiveWhitespaceCount: report.parserQuality.otherAnomalies.excessiveWhitespaceCount,
    blankNameCount: report.parserQuality.otherAnomalies.blankNameCount,
    literalUndefinedNullCount: report.parserQuality.otherAnomalies.literalUndefinedNullCount,
    productTypeRepeatedTwiceCount: report.parserQuality.otherAnomalies.productTypeRepeatedTwiceCount,
  },
}, null, 2));
md.push("```");
md.push("");
md.push("## Device labels");
md.push("```json");
md.push(JSON.stringify(report.deviceLabels, null, 2));
md.push("```");
md.push("");
md.push("## Name collisions");
md.push("```json");
md.push(JSON.stringify({ ...report.nameCollisions, worst30Groups: `${report.nameCollisions.worst30Groups.length} (see JSON)` }, null, 2));
md.push("```");
md.push("");
md.push("## Source identity");
md.push("```json");
md.push(JSON.stringify(report.sourceIdentity, null, 2));
md.push("```");
md.push("");
md.push("## Slug simulation");
md.push("```json");
md.push(JSON.stringify({ ...report.slugSimulation, longest30: `${report.slugSimulation.longest30.length} (see JSON)`, duplicateModelSlugExamples: `${report.slugSimulation.duplicateModelSlugExamples.length} (see JSON)` }, null, 2));
md.push("```");
md.push("");
md.push("## Name length");
md.push("```json");
md.push(JSON.stringify({ ...report.nameLength, longest50: `${report.nameLength.longest50.length} (see JSON)`, weakNameExamples: `${report.nameLength.weakNameExamples.length} (see JSON)` }, null, 2));
md.push("```");
md.push("");
md.push(`## Before/after samples (${samples.length})`);
for (const s of samples) {
  md.push(`### ${s.group}`);
  md.push(`- Raw: \`${s.rawName}\` (category: ${s.rawCategory}, manufacturer: ${s.manufacturer || "(none)"})`);
  md.push(`- New: \`${s.newName}\``);
  md.push(`- publicMaker: ${s.publicMaker || "(none)"} | brand: ${s.brand} | model: ${s.model}`);
  md.push(`- sourceKey: \`${s.sourceKey}\` | sourceProductId: ${s.sourceProductId ?? "(none)"}`);
  if (s.warnings.length) md.push(`- warnings: ${s.warnings.join("; ")}`);
  md.push("");
}
fs.writeFileSync(path.join(outDir, "phase-e-naming-report.md"), md.join("\n"));

console.log(`Wrote ${path.join(outDir, "phase-e-naming-report.json")}`);
console.log(`Wrote ${path.join(outDir, "phase-e-naming-report.md")}`);
console.log(JSON.stringify({
  rawProducts: report.counts.rawProducts,
  mappedRawProducts: report.counts.mappedRawProducts,
  unmappedRawProducts: report.counts.unmappedRawProducts,
  generatedRows: report.counts.generatedRows,
}, null, 2));
