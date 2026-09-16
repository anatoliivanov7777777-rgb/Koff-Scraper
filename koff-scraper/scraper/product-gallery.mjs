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
//
// Live-confirmed end-to-end (2026-09-16, authenticated, read-only, 3
// products: 388174/388192/388186): this exact request returns a 2-item
// `images` array for each, and the full pipeline through buildKoffImages
// (cover first, https-only, deduplicated) produced the correct ordered
// result for all three. ENABLE_GALLERY_FETCH is safe to turn on.
//
// fetchProductGallery below fails safe (ok:false) whenever the response
// does not match this exact verified contract - a missing/non-array
// `images` field, or a non-empty `images` array whose items don't yield
// any recognized `.url` - rather than reporting a false "authoritative
// empty gallery" that scrape.mjs would otherwise treat as confirmation to
// wipe an existing CaseKing gallery down to just the cover.
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
// any transport error, non-2xx status, malformed JSON, or a body that does
// not match the verified gallery contract degrades to
// { ok: false, images: [] } so a single product's detail failure can never
// abort processing of the rest of the catalog - and, critically, can never
// be mistaken downstream for an authoritative empty gallery (see
// isValidGalleryContract below).
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
  // The verified contract is `body.images` being an Array (see the module
  // header comment) - anything else (missing, null, a string, an object,
  // ...) means this response does not carry gallery data at all, and must
  // never be treated as "Koff confirmed zero images".
  if (!body || typeof body !== "object" || !Array.isArray(body.images)) {
    return { ok: false, images: [], reason: "invalid-shape" };
  }
  const images = extractGalleryUrls(body);
  // A non-empty images array that yields zero recognized URLs means the
  // item structure itself has drifted from the verified `{ url }` shape
  // (see extractGalleryUrls) - never a real product with only invalid
  // items. Fail safe rather than silently reporting an authoritative empty
  // gallery for what is actually an unrecognized response.
  if (body.images.length > 0 && images.length === 0) {
    return { ok: false, images: [], reason: "invalid-shape" };
  }
  return { ok: true, images };
}

// Coalesces concurrent ensureFreshToken() calls into a single in-flight
// refresh, so N pool workers all hitting a stale token around the same
// time trigger exactly one refresh cycle rather than a refresh storm of
// parallel /login/refresh calls. This reuses koffClient's own
// ensureFreshToken()/refreshAccessToken() - no separate/new auth logic -
// it only de-duplicates concurrent callers of the existing mechanism. If
// the in-flight refresh rejects, the guard resets so the very next caller
// gets a clean retry rather than being stuck on a permanently-broken state.
function coalescedTokenRefresher(koffClient) {
  let inFlight = null;
  return function ensureFreshTokenCoalesced() {
    if (!inFlight) {
      inFlight = Promise.resolve(koffClient.ensureFreshToken()).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

// Bounded-concurrency pool: fetches every requested product's gallery with
// at most `concurrency` requests in flight at once (never
// Promise.all(products.map(...)) over the full catalog), so a full sync
// with ~20k+ products stays operationally reasonable and never overwhelms
// koff.ro. Each product's fetch is isolated - one failure (including a
// token refresh failure) only affects that product's own map entry and
// never stops the pool from processing the remaining products.
//
// Each result is an explicit { ok, images } pair, never inferred from
// images.length alone: `ok: true` means the detail request succeeded and
// `images` is the supplier's authoritative gallery for this run (which may
// legitimately be a single image, or even empty if Koff genuinely reports
// none); `ok: false` means the fetch failed/errored and the caller must
// treat this product as "no gallery data this run" - NOT as an
// authoritative empty gallery. See scrape.mjs for how this distinction is
// used to avoid ever collapsing an existing multi-image CaseKing gallery
// down to just the cover on a transient failure.
//
// Calls the existing (coalesced) ensureFreshToken() before every request,
// same mechanism scrape.mjs's category crawl already uses - a full gallery
// pass can run far longer than the 8-minute token lifetime, and pool
// workers must not each independently discover a stale token.
//
// `sourceProductIds` should already be deduplicated by the caller (e.g. via
// the existing productsById Map in scrape.mjs) so a product listed under
// several categories is only fetched once.
export async function fetchGalleriesBounded(koffClient, sourceProductIds, { concurrency = 5 } = {}) {
  const ids = [...new Set(sourceProductIds)].filter((id) => Number.isInteger(id) && id > 0);
  const galleries = new Map();
  const counters = { attempted: ids.length, succeeded: 0, failed: 0, totalImagesFound: 0 };
  let cursor = 0;
  const ensureFreshTokenCoalesced = coalescedTokenRefresher(koffClient);

  async function runner() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      let result;
      try {
        await ensureFreshTokenCoalesced();
        result = await fetchProductGallery(koffClient, id);
      } catch {
        // A token-refresh failure (or anything else unexpected here) marks
        // only this one product as failed - fetchProductGallery already
        // catches its own errors, but a runner must never die mid-pool
        // regardless of what throws.
        result = { ok: false, images: [] };
      }
      galleries.set(id, { ok: result.ok, images: result.images });
      if (result.ok) {
        counters.succeeded++;
        counters.totalImagesFound += result.images.length;
      } else {
        counters.failed++;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: workerCount }, runner));
  return { galleries, counters };
}
