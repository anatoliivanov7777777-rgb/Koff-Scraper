import { test } from "node:test";
import assert from "node:assert/strict";
import { extractGalleryUrls, fetchProductGallery, fetchGalleriesBounded } from "../product-gallery.mjs";

// --- extractGalleryUrls: pure, no network ---

test("extractGalleryUrls reads a plain string array from the first recognized field", () => {
  assert.deepEqual(
    extractGalleryUrls({ images: ["https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/b.jpg"] }),
    ["https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/b.jpg"]
  );
});

test("extractGalleryUrls tries gallery/pictures/photos/media if images is absent", () => {
  assert.deepEqual(extractGalleryUrls({ gallery: ["https://cdn.koff.ro/g.jpg"] }), ["https://cdn.koff.ro/g.jpg"]);
  assert.deepEqual(extractGalleryUrls({ pictures: ["https://cdn.koff.ro/p.jpg"] }), ["https://cdn.koff.ro/p.jpg"]);
  assert.deepEqual(extractGalleryUrls({ photos: ["https://cdn.koff.ro/ph.jpg"] }), ["https://cdn.koff.ro/ph.jpg"]);
  assert.deepEqual(extractGalleryUrls({ media: ["https://cdn.koff.ro/m.jpg"] }), ["https://cdn.koff.ro/m.jpg"]);
});

test("extractGalleryUrls extracts a URL from an object item via known sub-fields", () => {
  assert.deepEqual(extractGalleryUrls({ images: [{ url: "https://cdn.koff.ro/o1.jpg" }] }), ["https://cdn.koff.ro/o1.jpg"]);
  assert.deepEqual(extractGalleryUrls({ images: [{ src: "https://cdn.koff.ro/o2.jpg" }] }), ["https://cdn.koff.ro/o2.jpg"]);
  assert.deepEqual(extractGalleryUrls({ images: [{ path: "https://cdn.koff.ro/o3.jpg" }] }), ["https://cdn.koff.ro/o3.jpg"]);
});

test("extractGalleryUrls preserves supplier order and does not deduplicate itself (buildKoffImages does that)", () => {
  assert.deepEqual(
    extractGalleryUrls({ images: ["https://cdn.koff.ro/b.jpg", "https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/b.jpg"] }),
    ["https://cdn.koff.ro/b.jpg", "https://cdn.koff.ro/a.jpg", "https://cdn.koff.ro/b.jpg"]
  );
});

test("extractGalleryUrls never crashes and never invents a URL on a malformed/unrecognized response", () => {
  assert.deepEqual(extractGalleryUrls(null), []);
  assert.deepEqual(extractGalleryUrls(undefined), []);
  assert.deepEqual(extractGalleryUrls("a string"), []);
  assert.deepEqual(extractGalleryUrls(42), []);
  assert.deepEqual(extractGalleryUrls({}), []);
  assert.deepEqual(extractGalleryUrls({ images: "not-an-array" }), []);
  assert.deepEqual(extractGalleryUrls({ images: [] }), []);
  assert.deepEqual(extractGalleryUrls({ images: [null, 42, {}, { unknownField: "x" }] }), []);
  assert.deepEqual(extractGalleryUrls({ someOtherField: ["https://cdn.koff.ro/x.jpg"] }), []);
});

test("extractGalleryUrls falls through to the next candidate field when the first is empty", () => {
  assert.deepEqual(extractGalleryUrls({ images: [], gallery: ["https://cdn.koff.ro/g.jpg"] }), ["https://cdn.koff.ro/g.jpg"]);
});

// --- fetchProductGallery: fake koffClient, no real network ---

function fakeClient(handler) {
  return { request: async (path) => handler(path) };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("fetchProductGallery requests the singular per-product detail route by numeric id", async () => {
  let requestedPath;
  const client = fakeClient((path) => { requestedPath = path; return jsonResponse(200, { images: ["https://cdn.koff.ro/a.jpg"] }); });
  const result = await fetchProductGallery(client, 388174);
  assert.equal(requestedPath, "/api/product/388174");
  assert.deepEqual(result, { ok: true, images: ["https://cdn.koff.ro/a.jpg"] });
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
  const responses = { 1: ["https://cdn.koff.ro/1a.jpg", "https://cdn.koff.ro/1b.jpg"], 2: ["https://cdn.koff.ro/2a.jpg"] };
  const client = fakeClient((path) => {
    const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
    return jsonResponse(200, { images: responses[id] ?? [] });
  });
  const { galleries, counters } = await fetchGalleriesBounded(client, [1, 2, 1, 2], { concurrency: 2 });
  assert.deepEqual(galleries.get(1), responses[1]);
  assert.deepEqual(galleries.get(2), responses[2]);
  assert.equal(galleries.size, 2);
  assert.deepEqual(counters, { attempted: 2, succeeded: 2, failed: 0, totalImagesFound: 3 });
});

test("fetchGalleriesBounded isolates one product's failure from the rest", async () => {
  const client = fakeClient((path) => {
    const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
    if (id === 2) throw new Error("boom");
    return jsonResponse(200, { images: [`https://cdn.koff.ro/${id}.jpg`] });
  });
  const { galleries, counters } = await fetchGalleriesBounded(client, [1, 2, 3], { concurrency: 2 });
  assert.deepEqual(galleries.get(1), ["https://cdn.koff.ro/1.jpg"]);
  assert.deepEqual(galleries.get(2), []);
  assert.deepEqual(galleries.get(3), ["https://cdn.koff.ro/3.jpg"]);
  assert.deepEqual(counters, { attempted: 3, succeeded: 2, failed: 1, totalImagesFound: 2 });
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
  const client = fakeClient(() => jsonResponse(200, { images: ["https://cdn.koff.ro/x.jpg"] }));
  const { galleries, counters } = await fetchGalleriesBounded(client, [0, -1, "a", NaN], { concurrency: 3 });
  assert.equal(galleries.size, 0);
  assert.deepEqual(counters, { attempted: 0, succeeded: 0, failed: 0, totalImagesFound: 0 });
});
