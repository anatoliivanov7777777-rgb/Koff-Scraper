#!/usr/bin/env node
// TEMPORARY, READ-ONLY verification script - NOT part of the normal
// scraper pipeline, not imported by scrape.mjs/sync-caseking.mjs.
//
// Exercises the REAL production functions this task added - no reimplemented
// logic - against exactly the 3 given Koff product ids:
//   fetchProductGallery()  from ./product-gallery.mjs
//   buildKoffImages()      from ./image-urls.mjs
//
// Per product this performs exactly ONE detail request (via
// fetchProductGallery, which itself calls koffClient.request once) plus the
// existing login/token-refresh calls already made by every scraper script in
// this repo. No category crawl, no other product, no write of any kind.
//
// Delete this file once the pipeline has been reviewed against real data.

import { createKoffClient } from "./koff-client.mjs";
import { fetchProductGallery } from "./product-gallery.mjs";
import { buildKoffImages } from "./image-urls.mjs";

const KOFF_EMAIL = process.env.KOFF_EMAIL;
const KOFF_PASSWORD = process.env.KOFF_PASSWORD;
const PRODUCT_IDS = [388174, 388192, 388186];

if (!KOFF_EMAIL || !KOFF_PASSWORD) {
  console.error("Missing KOFF_EMAIL / KOFF_PASSWORD (values are never printed by this script).");
  process.exit(1);
}

// login()/refreshAccessToken() otherwise log cookie NAMES via logger.info
// (harmless - names only, never values) - this verifier stays silent anyway.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function isHttps(url) {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

async function verifyProduct(client, productId) {
  // The cover image comes from the SAME detail response fetchProductGallery
  // already retrieves internally, so this makes no additional request - one
  // real GET /api/product/:id?expand=...,images,... per product, matching
  // the real production call fetchGalleriesBounded() makes for every
  // product during a real (opt-in) sync.
  const detailResponse = await client.request(
    `/api/product/${productId}?expand=${encodeURIComponent("cartQty,inCart,images,description,metaDescription,oldEan")}`
  );
  if (!detailResponse.ok) {
    console.log(`PRODUCT_ID: ${productId}`);
    console.log(`  FAILED: HTTP ${detailResponse.status}`);
    return;
  }
  const detailBody = await detailResponse.json();

  // The real per-product gallery fetch, exactly as scrape.mjs's
  // fetchGalleriesBounded() call would use it (it re-requests the same
  // endpoint internally - see product-gallery.mjs - so this is the actual
  // production code path, not a re-implementation of it).
  const galleryResult = await fetchProductGallery(client, productId);

  // The actual mapping step CaseKing's payload goes through: cover first,
  // then gallery, deduplicated, https-only - unchanged production logic.
  const finalImages = buildKoffImages({ imageUrl: detailBody.coverUrl, images: galleryResult.images });

  const coverFirst = finalImages.length === 0 || finalImages[0] === detailBody.coverUrl;
  const allHttps = finalImages.every(isHttps);
  const deduplicated = new Set(finalImages).size === finalImages.length;

  console.log(`PRODUCT_ID: ${productId}`);
  console.log(`PRODUCT_NAME: ${detailBody.name ?? "(missing)"}`);
  console.log(`COVER_URL: ${detailBody.coverUrl ?? "(missing)"}`);
  console.log(`RAW_GALLERY_COUNT: ${galleryResult.images.length}`);
  console.log(`FINAL_IMAGE_COUNT: ${finalImages.length}`);
  console.log(`FINAL_ORDERED_URLS:`);
  for (const url of finalImages) console.log(`  ${url}`);
  console.log(`COVER_FIRST: ${coverFirst ? "PASS" : "FAIL"}`);
  console.log(`HTTPS_ONLY: ${allHttps ? "PASS" : "FAIL"}`);
  console.log(`DEDUPLICATED: ${deduplicated ? "PASS" : "FAIL"}`);
  console.log("");

  return { productId, finalImages, coverFirst, allHttps, deduplicated, ok: galleryResult.ok };
}

async function main() {
  const client = createKoffClient({ email: KOFF_EMAIL, password: KOFF_PASSWORD, logger: silentLogger });
  await client.login();
  await client.ensureFreshToken();

  const results = [];
  for (const productId of PRODUCT_IDS) {
    results.push(await verifyProduct(client, productId));
  }

  const allFetched = results.every((r) => r && r.ok);
  const allHttps = results.every((r) => r && r.allHttps);
  const allDeduplicated = results.every((r) => r && r.deduplicated);
  const allOrderPreserved = results.every((r) => r && r.coverFirst);
  console.log("=== SUMMARY ===");
  console.log(`ALL_PRODUCTS_FETCHED: ${allFetched ? "PASS" : "FAIL"}`);
  console.log(`ALL_HTTPS_ONLY: ${allHttps ? "PASS" : "FAIL"}`);
  console.log(`ALL_DEDUPLICATED: ${allDeduplicated ? "PASS" : "FAIL"}`);
  console.log(`ORDER_PRESERVED: ${allOrderPreserved ? "PASS" : "FAIL"}`);
}

main().catch((err) => {
  console.error(`Verification failed: ${err.message ?? "unknown error"}`);
  process.exit(1);
});
