// Optional Koff product-detail gallery fetch, side-effect-free where
// possible so it can be unit tested without a network/koffClient.
//
// koff.ro's catalog LIST endpoint (/api/category/:id/products, already used
// by scrape.mjs) only ever exposes a single `coverUrl` per product -
// confirmed empirically (2026-09-16, read-only, unauthenticated request
// against a live category): the product object carries no images/gallery/
// media field at all. koff.ro DOES expose a singular per-product detail
// route, /api/product/:id (the same numeric id already extracted as
// sourceProductId in product-mapping.mjs) - confirmed to exist because it
// answers "Unauthorized" (a real application error) rather than "Not
// Found" when called without a session, exactly like every other
// authenticated koff.ro endpoint this scraper already calls via
// koff-client.mjs. Its authenticated JSON response shape - specifically
// which field carries the gallery array - has NOT been observed in this
// environment (no KOFF_EMAIL/KOFF_PASSWORD available here to log in), so
// extractGalleryUrls is deliberately defensive: it recognizes several
// plausible field names/shapes and returns an empty array (never a guess,
// never a fabricated URL) for anything it does not recognize. Because
// buildKoffImages/buildCaseKingProducts already treat "no gallery this
// run" identically to today's single-image behavior (see image-urls.mjs),
// an unrecognized response shape degrades safely to current production
// behavior rather than corrupting or losing any image.
//
// Before enabling ENABLE_GALLERY_FETCH in a real run, confirm the actual
// field name against one real authenticated /api/product/:id response and,
// if needed, add it to CANDIDATE_ARRAY_FIELDS below.

const CANDIDATE_ARRAY_FIELDS = ["images", "gallery", "pictures", "photos", "media"];
const CANDIDATE_ITEM_URL_FIELDS = ["url", "src", "path", "image", "original", "large", "href"];

function coerceUrl(item) {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    for (const field of CANDIDATE_ITEM_URL_FIELDS) {
      if (typeof item[field] === "string") return item[field];
    }
  }
  return null;
}

// Pure. Never throws - a response shape this function does not recognize
// simply yields no gallery images (see module comment above).
export function extractGalleryUrls(detailResponse) {
  if (!detailResponse || typeof detailResponse !== "object") return [];
  for (const field of CANDIDATE_ARRAY_FIELDS) {
    const value = detailResponse[field];
    if (!Array.isArray(value) || value.length === 0) continue;
    const urls = value.map(coerceUrl).filter((url) => typeof url === "string" && url.trim());
    if (urls.length > 0) return urls;
  }
  return [];
}

// Fetches ONE product's gallery through the already-authenticated
// koffClient (same session/CSRF/bearer-token handling as every other
// request in koff-client.mjs - no separate auth mechanism). Never throws:
// any transport error, non-2xx status or malformed JSON degrades to
// { ok: false, images: [] } so a single product's detail failure can never
// abort processing of the rest of the catalog.
export async function fetchProductGallery(koffClient, sourceProductId) {
  if (!Number.isInteger(sourceProductId) || sourceProductId <= 0) {
    return { ok: false, images: [], reason: "invalid-id" };
  }
  let response;
  try {
    response = await koffClient.request(`/api/product/${sourceProductId}`);
  } catch {
    return { ok: false, images: [], reason: "transport-error" };
  }
  if (!response.ok) return { ok: false, images: [], reason: `http-${response.status}` };
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, images: [], reason: "invalid-json" };
  }
  return { ok: true, images: extractGalleryUrls(body) };
}

// Bounded-concurrency pool: fetches every requested product's gallery with
// at most `concurrency` requests in flight at once (never
// Promise.all(products.map(...)) over the full catalog), so a full sync
// with ~20k+ products stays operationally reasonable and never overwhelms
// koff.ro. Each product's fetch is isolated - one failure only affects
// that product's own map entry (an empty array, i.e. "no gallery found
// this run", which downstream code already treats as safe/preserve-only)
// and never stops the pool from processing the remaining products.
//
// `sourceProductIds` should already be deduplicated by the caller (e.g. via
// the existing productsById Map in scrape.mjs) so a product listed under
// several categories is only fetched once.
export async function fetchGalleriesBounded(koffClient, sourceProductIds, { concurrency = 5 } = {}) {
  const ids = [...new Set(sourceProductIds)].filter((id) => Number.isInteger(id) && id > 0);
  const galleries = new Map();
  const counters = { attempted: ids.length, succeeded: 0, failed: 0, totalImagesFound: 0 };
  let cursor = 0;

  async function runner() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      let result;
      try {
        result = await fetchProductGallery(koffClient, id);
      } catch {
        // Defensive: fetchProductGallery already catches internally, but a
        // runner must never die mid-pool regardless of what throws here.
        result = { ok: false, images: [] };
      }
      galleries.set(id, result.images);
      if (result.ok && result.images.length > 0) {
        counters.succeeded++;
        counters.totalImagesFound += result.images.length;
      } else if (!result.ok) {
        counters.failed++;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: workerCount }, runner));
  return { galleries, counters };
}
