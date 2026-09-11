import { test } from "node:test";
import assert from "node:assert/strict";
import { isHttpsUrl, buildKoffImages } from "../image-urls.mjs";

test("isHttpsUrl accepts only absolute https:// URLs", () => {
  assert.equal(isHttpsUrl("https://shop.koff.ro/img/cover.webp"), true);
  assert.equal(isHttpsUrl("http://shop.koff.ro/img/cover.webp"), false);
  assert.equal(isHttpsUrl("javascript:alert(1)"), false);
  assert.equal(isHttpsUrl("data:image/png;base64,aaaa"), false);
  assert.equal(isHttpsUrl("file:///etc/passwd"), false);
  assert.equal(isHttpsUrl(""), false);
  assert.equal(isHttpsUrl(undefined), false);
  assert.equal(isHttpsUrl(null), false);
  assert.equal(isHttpsUrl("not a url"), false);
});

test("buildKoffImages stores the direct supplier image URL, primary first", () => {
  const images = buildKoffImages({ imageUrl: "https://shop.koff.ro/img/cover.webp" });
  assert.deepEqual(images, ["https://shop.koff.ro/img/cover.webp"]);
});

test("buildKoffImages preserves supplier ordering: primary then gallery", () => {
  const images = buildKoffImages({
    imageUrl: "https://shop.koff.ro/img/cover.webp",
    images: ["https://shop.koff.ro/img/side.webp", "https://shop.koff.ro/img/back.webp"],
  });
  assert.deepEqual(images, [
    "https://shop.koff.ro/img/cover.webp",
    "https://shop.koff.ro/img/side.webp",
    "https://shop.koff.ro/img/back.webp",
  ]);
});

test("buildKoffImages deduplicates identical URLs", () => {
  const images = buildKoffImages({
    imageUrl: "https://shop.koff.ro/img/cover.webp",
    images: ["https://shop.koff.ro/img/cover.webp", "https://shop.koff.ro/img/back.webp"],
  });
  assert.deepEqual(images, [
    "https://shop.koff.ro/img/cover.webp",
    "https://shop.koff.ro/img/back.webp",
  ]);
});

test("buildKoffImages drops non-https candidates but keeps valid ones", () => {
  const images = buildKoffImages({
    imageUrl: "javascript:alert(1)",
    images: ["https://shop.koff.ro/img/back.webp", "data:image/png;base64,aaaa"],
  });
  assert.deepEqual(images, ["https://shop.koff.ro/img/back.webp"]);
});

test("buildKoffImages returns an empty array on empty/malformed supplier response (caller must not wipe existing images with this)", () => {
  assert.deepEqual(buildKoffImages({}), []);
  assert.deepEqual(buildKoffImages({ imageUrl: null }), []);
  assert.deepEqual(buildKoffImages({ imageUrl: "" }), []);
  assert.deepEqual(buildKoffImages(null), []);
});
