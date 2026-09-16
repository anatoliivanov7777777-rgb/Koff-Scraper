import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGalleryUrls, fetchProductGallery, fetchGalleriesBounded } from "../product-gallery.mjs";

// Fixture matching the VERIFIED real shape (decompiled from koff.ro's own
// live product-detail frontend chunk, see product-gallery.mjs's header
// comment): `images` is an array of objects, each exposing a `.url` string,
// rendered directly as <img src={item.url}>.
const REAL_SHAPE_RESPONSE = {
  id: 388174,
  name: "Techsuit - HaloFrost II MagSafe - iPhone 18 Pro / iPhone 17 Pro - Dark Cherry",
  coverUrl: "https://cdn.koff.ro/img/3/2/8/1/0/8/9/3281089.jpg",
  images: [
    { url: "https://cdn.koff.ro/img/3/2/8/1/0/8/9/3281089.jpg" },
    { url: "https://cdn.koff.ro/img/3/2/8/1/0/9/0/3281090.jpg" },
    { url: "https://cdn.koff.ro/img/3/2/8/1/0/9/1/3281091.jpg" },
  ],
};

// --- extractGalleryUrls: pure, no network ---

test("extractGalleryUrls reads .url from each object in the verified images array", () => {
  assert.deepEqual(extractGalleryUrls(REAL_SHAPE_RESPONSE), [
    "https://cdn.koff.ro/img/3/2/8/1/0/8/9/3281089.jpg",
    "https://cdn.koff.ro/img/3/2/8/1/0/9/0/3281090.jpg",
    "https://cdn.koff.ro/img/3/2/8/1/0/9/1/3281091.jpg",
  ]);
});

test("extractGalleryUrls preserves supplier order and does not deduplicate itself (buildKoffImages does that)", () => {
  assert.deepEqual(
    extractGalleryUrls({ images: [{ url: "https://cdn.koff.ro/b.jpg" }, { url: "https://cdn.koff.ro/a.jpg" }, { url: "https://cdn.koff.ro/b.jpg" }] }),
    ["https://cdn.koff.ro/b.jpg", "https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/b.jpg"]
  );
});

test("extractGalleryUrls no longer recognizes other field names or shapes (speculative guessing removed)", () => {
  // Other candidate field names considered before the real shape was
  // verified - none of these are the real API, so none are parsed anymore.
  assert.deepEqual(extractGalleryUrls({ gallery: [{ url: "https://cdn.koff.ro/g.jpg" }] }), []);
  assert.deepEqual(extractGalleryUrls({ media: { images: [{ url: "https://cdn.koff.ro/m.jpg" }] } }), []);
  // Item shapes other than {url} are no longer recognized either.
  assert.deepEqual(extractGalleryUrls({ images: [{ src: "https://cdn.koff.ro/o2.jpg" }] }), []);
  assert.deepEqual(extractGalleryUrls({ images: [{ path: "https://cdn.koff.ro/o3.jpg" }] }), []);
  assert.deepEqual(extractGalleryUrls({ images: ["https://cdn.koff.ro/plain-string.jpg"] }), []);
});

test("extractGalleryUrls never crashes and never invents a URL on a malformed/unrecognized response", () => {
  assert.deepEqual(extractGalleryUrls(null), []);
  assert.deepEqual(extractGalleryUrls(undefined), []);
  assert.deepEqual(extractGalleryUrls("a string"), []);
  assert.deepEqual(extractGalleryUrls(42), []);
  assert.deepEqual(extractGalleryUrls({}), []);
  assert.deepEqual(extractGalleryUrls({ images: "not-an-array" }), []);
  assert.deepEqual(extractGalleryUrls({ images: [] }), []);
  assert.deepEqual(extractGalleryUrls({ images: [null, 42, {}, { url: 5 }, { unknownField: "x" }] }), []);
  assert.deepEqual(extractGalleryUrls({ someOtherField: [{ url: "https://cdn.koff.ro/x.jpg" }] }), []);
});

test("extractGalleryUrls drops non-string/empty url values but keeps the valid ones in the same array", () => {
  assert.deepEqual(
    extractGalleryUrls({ images: [{ url: "https://cdn.koff.ro/a.jpg" }, { url: "" }, { url: null }, { url: "https://cdn.koff.ro/b.jpg" }] }),
    ["https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/b.jpg"]
  );
});

// --- fetchProductGallery: fake koffClient, no real network ---

function fakeClient(handler, { ensureFreshToken = async () => {} } = {}) {
  return { request: async (path) => handler(path), ensureFreshToken };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("fetchProductGallery requests /api/product/:id with the verified expand parameter (images included)", async () => {
  let requestedPath;
  const client = fakeClient((path) => { requestedPath = path; return jsonResponse(200, REAL_SHAPE_RESPONSE); });
  const result = await fetchProductGallery(client, 388174);
  assert.equal(requestedPath, "/api/product/388174?expand=cartQty%2CinCart%2Cimages%2Cdescription%2CmetaDescription%2ColdEan");
  assert.deepEqual(result, { ok: true, images: extractGalleryUrls(REAL_SHAPE_RESPONSE) });
});

test("fetchProductGallery reproduces the confirmed probe result: /api/product/388174 WITHOUT expand has no images field", async () => {
  // This is exactly what the earlier read-only probe observed: HTTP 200,
  // but no images/gallery/media field at all when `expand` omits `images`.
  const withoutExpand = {
    id: 388174, name: "Techsuit - HaloFrost II MagSafe - iPhone 18 Pro / iPhone 17 Pro - Dark Cherry",
    sku: "KF2368383", coverUrl: "https://cdn.koff.ro/img/3/2/8/1/0/8/9/3281089.jpg",
    max: 1, basePrice: null, salePrice: null,
  };
  assert.deepEqual(extractGalleryUrls(withoutExpand), []);
});

test("fetchProductGallery degrades to ok:false/[] on a non-2xx response, without throwing", async () => {
  const client = fakeClient(() => jsonResponse(401, {}));
  const result = await fetchProductGallery(client, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.images, []);
});

test("fetchProductGallery degrades to ok:false/[] on a transport error, without throwing", async () => {
  const client = fakeClient(() => { throw new Error("network down"); });
  const result = await fetchProductGallery(client, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.images, []);
});

test("fetchProductGallery degrades to ok:false/[] on malformed JSON, without throwing", async () => {
  const client = fakeClient(() => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
  const result = await fetchProductGallery(client, 1);
  assert.equal(result.ok, false);
  assert.deepEqual(result.images, []);
});

test("fetchProductGallery rejects a non-positive-integer id without making a request", async () => {
  let called = false;
  const client = fakeClient(() => { called = true; return jsonResponse(200, {}); });
  for (const bad of [0, -1, 1.5, NaN, "388174", null, undefined]) {
    const result = await fetchProductGallery(client, bad);
    assert.equal(result.ok, false);
    assert.deepEqual(result.images, []);
  }
  assert.equal(called, false);
});

// --- fetchGalleriesBounded: concurrency, isolation, counters ---

test("fetchGalleriesBounded fetches every id, deduplicated, and keeps cover-image order semantics to the caller", async () => {
  const responses = {
    1: [{ url: "https://cdn.koff.ro/1a.jpg" }, { url: "https://cdn.koff.ro/1b.jpg" }],
    2: [{ url: "https://cdn.koff.ro/2a.jpg" }],
  };
  const client = fakeClient((path) => {
    const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
    return jsonResponse(200, { images: responses[id] ?? [] });
  });
  const { galleries, counters } = await fetchGalleriesBounded(client, [1, 2, 1, 2], { concurrency: 2 });
  assert.deepEqual(galleries.get(1), { ok: true, images: ["https://cdn.koff.ro/1a.jpg", "https://cdn.koff.ro/1b.jpg"] });
  assert.deepEqual(galleries.get(2), { ok: true, images: ["https://cdn.koff.ro/2a.jpg"] });
  assert.equal(galleries.size, 2);
  assert.deepEqual(counters, { attempted: 2, succeeded: 2, failed: 0, totalImagesFound: 3 });
});

test("fetchGalleriesBounded isolates one product's failure from the rest, with an explicit ok:false (not just an empty array)", async () => {
  const client = fakeClient((path) => {
    const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
    if (id === 2) throw new Error("boom");
    return jsonResponse(200, { images: [{ url: `https://cdn.koff.ro/${id}.jpg` }] });
  });
  const { galleries, counters } = await fetchGalleriesBounded(client, [1, 2, 3], { concurrency: 2 });
  assert.deepEqual(galleries.get(1), { ok: true, images: ["https://cdn.koff.ro/1.jpg"] });
  assert.deepEqual(galleries.get(2), { ok: false, images: [] });
  assert.deepEqual(galleries.get(3), { ok: true, images: ["https://cdn.koff.ro/3.jpg"] });
  assert.deepEqual(counters, { attempted: 3, succeeded: 2, failed: 1, totalImagesFound: 2 });
});

test("fetchGalleriesBounded marks a genuinely successful but empty gallery as ok:true, distinct from a failure", async () => {
  const client = fakeClient(() => jsonResponse(200, { images: [] }));
  const { galleries, counters } = await fetchGalleriesBounded(client, [1], { concurrency: 1 });
  assert.deepEqual(galleries.get(1), { ok: true, images: [] });
  assert.deepEqual(counters, { attempted: 1, succeeded: 1, failed: 0, totalImagesFound: 0 });
});

test("fetchGalleriesBounded never exceeds the configured concurrency", async () => {
  let inFlight = 0, maxInFlight = 0;
  const client = fakeClient(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return jsonResponse(200, { images: [] });
  });
  const ids = Array.from({ length: 20 }, (_, i) => i + 1);
  await fetchGalleriesBounded(client, ids, { concurrency: 3 });
  assert.ok(maxInFlight <= 3, `expected at most 3 in flight, saw ${maxInFlight}`);
});

test("fetchGalleriesBounded ignores non-positive-integer ids and reports an empty plan for an empty list", async () => {
  const client = fakeClient(() => jsonResponse(200, { images: [{ url: "https://cdn.koff.ro/x.jpg" }] }));
  const { galleries, counters } = await fetchGalleriesBounded(client, [0, -1, "a", NaN], { concurrency: 3 });
  assert.equal(galleries.size, 0);
  assert.deepEqual(counters, { attempted: 0, succeeded: 0, failed: 0, totalImagesFound: 0 });
});
