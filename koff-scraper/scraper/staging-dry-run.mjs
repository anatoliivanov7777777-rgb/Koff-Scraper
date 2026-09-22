// ============================================================================
// STAGING DRY-RUN — normalizes the current catalog and produces a review manifest
// ----------------------------------------------------------------------------
// Pipeline (all READ-ONLY against CaseKing):
//
//   scraped catalog
//     -> caseking-product-normalization.mjs   (the SAME pure module production
//                                              sync uses - identity, pricing,
//                                              naming, images)
//     -> koffStagingSync:resolveExistingProducts   (staging, query only)
//     -> classify (staging-sync.mjs)
//     -> deterministic manifest + SHA-256
//
// It NEVER calls updateExistingProducts and NEVER writes to CaseKing.
//
// The resolver is an authenticated syncQuery, so the CASEKING_SYNC_SECRET for
// aware-toucan-771 is required. The target guard rejects every other deployment.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCaseKingProducts,
  resolveCategorySlug,
  isSellable,
} from "./caseking-product-normalization.mjs";
import {
  classifyRow,
  buildManifest,
  writeManifest,
  tally,
  preflight,
  resolveAll,
  DISPOSITION,
} from "./staging-sync.mjs";

const STAGING_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";

// ---------------------------------------------------------------------------
// 1. Normalize
// ---------------------------------------------------------------------------
function normalizeCatalog(catalog, galleryByProductId) {
  const rows = [];
  let unmappedCategory = 0;

  for (const raw of catalog) {
    const slug = resolveCategorySlug(raw);
    if (slug === null) { unmappedCategory++; continue; }

    // Attach the gallery the gallery-state pipeline collected for this product,
    // so buildCaseKingProducts sees a genuine `images` array and the multi-image
    // path is exercised exactly as it is in a real sync run.
    const gallery = galleryByProductId.get(raw.sourceProductId);
    const withGallery = gallery && gallery.length
      ? { ...raw, images: gallery.slice(1) }   // [0] is the cover already in imageUrl
      : raw;

    for (const built of buildCaseKingProducts(withGallery, slug)) {
      rows.push({
        raw,
        built,
        sellable: isSellable(built),
        proposed: {
          image: built.image ?? null,
          images: Array.isArray(built.images) ? built.images : null,
          priceB2C: built.priceB2C ?? null,
          priceB2B: built.priceB2B ?? null,
        },
      });
    }
  }
  return { rows, unmappedCategory };
}

// ---------------------------------------------------------------------------
// 2. Main
// ---------------------------------------------------------------------------
async function main() {
  const catalogPath = process.env.CATALOG_PATH || "koff-products-raw.json";
  const galleryPath = process.env.GALLERY_PATH || "gallery-state-export.json";
  const outDir = process.env.OUT_DIR || "staging-dry-run-out";
  const CHECKSUM_PREFIX = process.env.GITHUB_SHA || "local";

  console.error(`catalog: ${catalogPath}`);

  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  const catalogRows = Array.isArray(catalog) ? catalog : catalog.products || [];

  // Gallery state, if exported alongside the catalog. Absent is fine: the
  // multi-image path simply is not exercised, exactly as in a run that did not
  // fetch galleries.
  let galleryByProductId = new Map();
  try {
    const g = JSON.parse(readFileSync(galleryPath, "utf8"));
    const rows = Array.isArray(g) ? g : g.rows || [];
    for (const r of rows) {
      if (Number.isInteger(r.sourceProductId) && Array.isArray(r.galleryUrls)) {
        galleryByProductId.set(r.sourceProductId, r.galleryUrls);
      }
    }
    console.error(`gallery state rows: ${galleryByProductId.size}`);
  } catch {
    console.error("gallery state: not provided (images[] path will be idle)");
  }

  const { rows, unmappedCategory } = normalizeCatalog(catalogRows, galleryByProductId);
  console.error(`normalized rows: ${rows.length} (unmapped category: ${unmappedCategory})`);

  // --- target + credential gate (throws on any non-staging target) ---------
  const gate = preflight({
    convexUrl: STAGING_URL,
    syncSecret: process.env.CASEKING_STAGING_SYNC_SECRET || process.env.CASEKING_SYNC_SECRET,
  });
  console.error(`target OK: ${gate.deploymentId}`);

  // --- resolve (read-only) -------------------------------------------------
  const resolveInputs = rows.map((r) => ({
    sourceKey: r.built.sourceKey,
    name: r.built.name,
    brand: r.built.brand,
    model: r.built.model,
    category: r.built.category,
  }));

  const resolutions = await resolveAll(resolveInputs, {
    baseUrl: gate.baseUrl,
    syncSecret: process.env.CASEKING_STAGING_SYNC_SECRET || process.env.CASEKING_SYNC_SECRET,
    batchSize: 100,
  });
  console.error(`resolved: ${resolutions.length}`);

  // --- classify ------------------------------------------------------------
  const dispositions = [];
  const entries = [];
  for (let i = 0; i < rows.length; i++) {
    const d = classifyRow(resolutions[i], rows[i].proposed);
    dispositions.push(d);
    if (d === DISPOSITION.SAFE_UPDATE_EXISTING) {
      entries.push({ resolution: resolutions[i], proposed: rows[i].proposed });
    }
  }

  const counts = tally(dispositions, entries);

  // --- manifest (deterministic) -------------------------------------------
  const manifest = buildManifest(entries);
  const regen = buildManifest([...entries].reverse());

  mkdirSync(outDir, { recursive: true });
  writeManifest(resolve(outDir, "staging-update-manifest.json"), manifest);

  const report = {
    generatedFrom: { catalogPath, catalogRows: catalogRows.length, galleryRows: galleryByProductId.size },
    target: gate.deploymentId,
    checksumPrefix: CHECKSUM_PREFIX,
    normalizedRows: rows.length,
    unmappedCategory,
    counts,
    manifestRows: manifest.payload.rows.length,
    manifestSha256: manifest.sha256,
    deterministic: {
      byteIdentical: manifest.canonical === regen.canonical,
      sha256Identical: manifest.sha256 === regen.sha256,
    },
    samples: {
      imageChanges: entries.filter((e) => e.proposed.images && e.proposed.images.length !== e.resolution.currentImagesCount).slice(0, 20).map((e) => ({
        productId: e.resolution.productId,
        sourceKey: e.resolution.currentSourceKey,
        sourceProductId: e.resolution.currentSourceProductId,
        currentImagesCount: e.resolution.currentImagesCount,
        proposedImagesCount: e.proposed.images.length,
      })),
      priceChanges: entries.filter((e) => e.proposed.priceB2C !== e.resolution.currentPriceB2C).slice(0, 20).map((e) => ({
        productId: e.resolution.productId,
        currentPriceB2C: e.resolution.currentPriceB2C,
        proposedPriceB2C: e.proposed.priceB2C,
        currentPriceB2B: e.resolution.currentPriceB2B,
        proposedPriceB2B: e.proposed.priceB2B,
      })),
    },
  };
  writeFileSync(resolve(outDir, "staging-dry-run-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");

  // Never invoke the mutation. Stated here so the intent is auditable.
  console.error("DRY RUN COMPLETE - updateExistingProducts was NOT called.");

  console.log(JSON.stringify({
    TOTAL_KOFF_CANDIDATES: counts.total,
    SAFE_UPDATE_EXISTING: counts.SAFE_UPDATE_EXISTING,
    NO_CHANGE: counts.NO_CHANGE,
    AMBIGUOUS: counts.AMBIGUOUS,
    NOT_FOUND: counts.NOT_FOUND,
    CONFLICT: counts.CONFLICT,
    CREATE: 0,
    IMAGES_CHANGE: counts.IMAGES_CHANGE,
    PRICE_B2C_CHANGE: counts.PRICE_B2C_CHANGE,
    PRICE_B2B_CHANGE: counts.PRICE_B2B_CHANGE,
    BOTH_IMAGE_AND_PRICE_CHANGE: counts.BOTH_IMAGE_AND_PRICE_CHANGE,
    MANIFEST_ROWS: manifest.payload.rows.length,
    MANIFEST_SHA256: manifest.sha256,
  }, null, 1));
}

// Only run when invoked directly, so importing this file has no side effects.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((e) => { console.error("FAILED: " + e.message); process.exit(1); });
}
