// Optional Koff product-detail gallery fetch, side-effect-free where
// possible so it can be unit tested without a network/koffClient.
//
// koff.ro's catalog LIST endpoint (/api/category/:id/products, already used
// by scrape.mjs) only ever exposes a single `coverUrl` per product -
// confirmed empirically (2026-09-16, read-only, unauthenticated request
// against a live category): the product object carries no images/gallery/
// media field at all.
//
// The gallery source is VERIFIED, not guessed: decompiled from koff.ro's own
// live frontend bundle (2026-09-16, static inspection, no login required -
// https://shop.koff.ro/app/0.9.78/js/DCZ9xb2m.js resolves the router's
// `p/:id`/`product/:id` route to a lazily-loaded chunk,
// https://shop.koff.ro/app/0.9.78/js/TBDfO2Pk.js, which on mount performs:
//   await Dt.get(`/api/product/${id}`, { params: { expand:
//     "cartQty,inCart,images,description,metaDescription,oldEan" } })
// and renders the gallery/thumbnail sliders as `Ft(s.value.images, (H, U) =>
// ... <img src={H.url} ...>)` - i.e. the response has an `images` array
// whose items are objects exposing (at least) a `.url` string, and the
// SAME /api/product/:id route this module already called is correct - the
// only thing missing was the `expand=...,images,...` query parameter (the
// probe run against /api/product/388174 without it, confirming the field is
// genuinely absent unless requested - matching the catalog list endpoint's
// own existing `expand=cartQty,inCart` pattern already used in scrape.mjs).
//
// PRODUCT_DETAIL_EXPAND intentionally matches the frontend's own expand list
// verbatim rather than trimming it to only "images", to stay on the exact
// verified, working request rather than an untested variant.
const PRODUCT_DETAIL_EXPAND = "cartQty,inCart,images,description,metaDescription,oldEan";

// Pure. Never throws. Parses only the verified real shape
// (`detailResponse.images[].url`) - no speculative field-name guessing.
// A response that does not match this exact shape (e.g. koff.ro changes its
// API, or a transient malformed body) yields no gallery images rather than
// throwing; see buildKoffImages/buildCaseKingProducts in image-urls.mjs/
// sync-caseking.mjs for why that degrades safely to today's single-image
// behavior instead of losing or corrupting an existing image.
export function extractGalleryUrls(detailResponse) {
  if (!detailResponse || typeof detailResponse !== "object") return [];
  const images = detailResponse.images;
  if (!Array.isArray(images)) return [];
  return images
    .map((item) => (item && typeof item === "object" ? item.url : null))
    .filter((url) => typeof url === "string" && url.trim());
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
    response = await koffClient.request(
      `/api/product/${sourceProductId}?expand=${encodeURIComponent(PRODUCT_DETAIL_EXPAND)}`
    );
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
