// Full-pipeline coverage of the required contract: a transient gallery
// failure must never collapse an existing multi-image CaseKing gallery
// down to just the cover, while a genuinely SUCCESSFUL gallery fetch -
// even one that resolves to a single image - is authoritative and may
// legitimately update the existing gallery. Exercises the real
// buildCaseKingProducts() (sync-caseking.mjs), the same function the real
// sync uses, on raw objects shaped exactly like scrape.mjs's real output:
// `imageUrl` always present (from the catalog list's coverUrl), `images`
// present ONLY when scrape.mjs's gallery fetch for that product succeeded
// (see scrape.mjs's ENABLE_GALLERY_FETCH block).
import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded -
// see the bottom of sync-caseking.mjs). Pure function only, no network.
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { buildCaseKingProducts } = await import("../sync-caseking.mjs");
const { fetchGalleriesBounded } = await import("../product-gallery.mjs");

function baseRaw(overrides = {}) {
  return {
    sourceId: "KF1000001",
    id: 380614,
    name: "Spigen - Liquid Air - iPhone 16 - Black",
    manufacturer: "Spigen",
    basePrice: 5,
    stock: 10,
    imageUrl: "https://cdn.koff.ro/img/cover.jpg",
    ...overrides,
  };
}

test("1. successful multi-image gallery updates the full gallery", () => {
  const raw = baseRaw({ images: ["https://cdn.koff.ro/img/cover.jpg", "https://cdn.koff.ro/img/g1.jpg", "https://cdn.koff.ro/img/g2.jpg"] });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.image, "https://cdn.koff.ro/img/cover.jpg");
  assert.deepEqual(product.images, [
    "https://cdn.koff.ro/img/cover.jpg",
    "https://cdn.koff.ro/img/g1.jpg",
    "https://cdn.koff.ro/img/g2.jpg",
  ]);
});

test("2. successful single-image gallery (Koff explicitly returns just the cover) updates images to [cover]", () => {
  const raw = baseRaw({ images: ["https://cdn.koff.ro/img/cover.jpg"] });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.image, "https://cdn.koff.ro/img/cover.jpg");
  assert.deepEqual(product.images, ["https://cdn.koff.ro/img/cover.jpg"]);
});

test("3. failed gallery + valid cover: cover still updates, images field is OMITTED downstream", () => {
  // scrape.mjs never sets `.images` on a failed detail request - this is
  // exactly the shape a failed fetch produces: imageUrl present, images absent.
  const raw = baseRaw();
  assert.equal("images" in raw, false);
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.image, "https://cdn.koff.ro/img/cover.jpg");
  assert.equal("images" in product, false);
});

test("4. a failed gallery can never collapse an existing gallery to [cover] - CaseKing-side contract check", () => {
  // Mirrors exactly what convex/products.ts:upsertBatch does: `image` is
  // patched only if the field was provided, `images` is patched only if
  // that field was provided independently - proving the omitted `images`
  // key from case 3 above leaves an existing multi-image gallery untouched
  // rather than being overwritten with a 1-item array.
  const raw = baseRaw();
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  const { id, image, images, sourceProductId, publicMaker, ...data } = product;
  const existing = { images: ["https://cdn.koff.ro/img/cover.jpg", "https://cdn.koff.ro/img/old-gallery-1.jpg", "https://cdn.koff.ro/img/old-gallery-2.jpg"] };
  const patch = { ...data };
  if (image !== undefined) patch.image = image;
  if (images !== undefined) patch.images = images;
  const patchedImages = "images" in patch ? patch.images : existing.images;
  assert.deepEqual(patchedImages, existing.images);
});

test("5. a failed detail request does not abort other products (fetchGalleriesBounded isolation, ok/images explicit per id)", async () => {
  const client = {
    ensureFreshToken: async () => {},
    request: async (path) => {
      const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
      if (id === 2) throw new Error("boom");
      return { ok: true, status: 200, json: async () => ({ images: [{ url: `https://cdn.koff.ro/${id}.jpg` }] }) };
    },
  };
  const { galleries, counters } = await fetchGalleriesBounded(client, [1, 2, 3], { concurrency: 2 });
  assert.deepEqual(galleries.get(1), { ok: true, images: ["https://cdn.koff.ro/1.jpg"] });
  assert.deepEqual(galleries.get(2), { ok: false, images: [] });
  assert.deepEqual(galleries.get(3), { ok: true, images: ["https://cdn.koff.ro/3.jpg"] });
  assert.deepEqual(counters, { attempted: 3, succeeded: 2, failed: 1, totalImagesFound: 2 });
});

test("6. token freshness is checked (coalesced) during a gallery pass, not skipped under concurrency", async () => {
  let refreshCalls = 0;
  let concurrentRefreshes = 0;
  let inFlightRefreshes = 0;
  const client = {
    ensureFreshToken: async () => {
      refreshCalls++;
      inFlightRefreshes++;
      concurrentRefreshes = Math.max(concurrentRefreshes, inFlightRefreshes);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightRefreshes--;
    },
    request: async (path) => {
      const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
      return { ok: true, status: 200, json: async () => ({ images: [{ url: `https://cdn.koff.ro/${id}.jpg` }] }) };
    },
  };
  const ids = Array.from({ length: 12 }, (_, i) => i + 1);
  await fetchGalleriesBounded(client, ids, { concurrency: 4 });
  assert.ok(refreshCalls > 0, "ensureFreshToken must actually be invoked during the gallery pass");
  assert.equal(concurrentRefreshes, 1, `concurrent workers must coalesce into one in-flight refresh at a time, saw ${concurrentRefreshes}`);
});

test("6b. a token-refresh failure only fails that one product, and self-heals for the next call", async () => {
  let refreshCallCount = 0;
  const client = {
    ensureFreshToken: async () => {
      refreshCallCount++;
      if (refreshCallCount === 1) throw new Error("refresh failed");
    },
    request: async (path) => {
      const id = Number(path.match(/\/api\/product\/(\d+)/)[1]);
      return { ok: true, status: 200, json: async () => ({ images: [{ url: `https://cdn.koff.ro/${id}.jpg` }] }) };
    },
  };
  const { galleries, counters } = await fetchGalleriesBounded(client, [1, 2], { concurrency: 1 });
  assert.deepEqual(galleries.get(1), { ok: false, images: [] });
  assert.deepEqual(galleries.get(2), { ok: true, images: ["https://cdn.koff.ro/2.jpg"] });
  assert.deepEqual(counters, { attempted: 2, succeeded: 1, failed: 1, totalImagesFound: 1 });
});

test("7. existing https/dedup/order behavior remains unchanged when the gallery repeats the cover", () => {
  const raw = baseRaw({ images: ["http://cdn.koff.ro/insecure.jpg", "https://cdn.koff.ro/img/cover.jpg", "https://cdn.koff.ro/img/g1.jpg", "https://cdn.koff.ro/img/g1.jpg"] });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.image, "https://cdn.koff.ro/img/cover.jpg");
  assert.deepEqual(product.images, ["https://cdn.koff.ro/img/cover.jpg", "https://cdn.koff.ro/img/g1.jpg"]);
});

test("no cover and a failed gallery still omits image/images entirely (unchanged preserve-on-empty behavior)", () => {
  const raw = baseRaw({ imageUrl: undefined });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal("image" in product, false);
  assert.equal("images" in product, false);
});

test("no cover but a successful gallery still promotes the gallery's first image to cover", () => {
  const raw = baseRaw({ imageUrl: undefined, images: ["https://cdn.koff.ro/img/g1.jpg", "https://cdn.koff.ro/img/g2.jpg"] });
  const [product] = buildCaseKingProducts(raw, "keysove-i-kalufi");
  assert.equal(product.image, "https://cdn.koff.ro/img/g1.jpg");
  assert.deepEqual(product.images, ["https://cdn.koff.ro/img/g1.jpg", "https://cdn.koff.ro/img/g2.jpg"]);
});
