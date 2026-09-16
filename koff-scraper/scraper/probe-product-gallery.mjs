#!/usr/bin/env node
// TEMPORARY, READ-ONLY diagnostic script - NOT part of the normal scraper
// pipeline, not imported by scrape.mjs/sync-caseking.mjs.
//
// Purpose: authenticate with the existing Koff session flow
// (koff-client.mjs - the exact same login/cookie/CSRF/bearer-token
// handling every other request in this repo already uses) and issue
// EXACTLY ONE GET request to /api/product/:id, then print a heavily
// sanitized structural summary of the response - never the raw body,
// never any header, cookie, token or credential.
//
// Usage (from koff-scraper/scraper):
//   KOFF_EMAIL=... KOFF_PASSWORD=... node probe-product-gallery.mjs [productId]
//
// Delete this file once the real gallery field has been confirmed and
// product-gallery.mjs has been updated to parse it directly - it exists
// only to make that one confirmation possible.

import { createKoffClient } from "./koff-client.mjs";

const KOFF_EMAIL = process.env.KOFF_EMAIL;
const KOFF_PASSWORD = process.env.KOFF_PASSWORD;
const PRODUCT_ID = Number.parseInt(process.argv[2] ?? process.env.PROBE_PRODUCT_ID ?? "388174", 10);

if (!KOFF_EMAIL || !KOFF_PASSWORD) {
  console.error("Missing KOFF_EMAIL / KOFF_PASSWORD (values are never printed by this script).");
  process.exit(1);
}
if (!Number.isInteger(PRODUCT_ID) || PRODUCT_ID <= 0) {
  console.error("Invalid product id argument.");
  process.exit(1);
}

// A silent logger: koff-client.mjs's login()/refreshAccessToken() otherwise
// log cookie NAMES via logger.info - harmless (names only, never values),
// but this probe stays maximally quiet regardless.
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const IMAGE_URL_KEYS = ["url", "src", "path", "image", "original", "large", "href"];
const CANDIDATE_FIELD_PATTERN = /image|gallery|photo|media|picture/i;
const HTTPS_IMAGE_RE = /^https:\/\/\S+\.(jpe?g|png|webp|gif|avif)(\?\S*)?$/i;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// Prints only structure (field names, types, lengths) - never arbitrary
// values, except a string that is itself a plausible https image URL
// (which is the one thing this probe exists to find).
function describeValue(value, indent) {
  const pad = "  ".repeat(indent);
  if (typeof value === "string") {
    if (HTTPS_IMAGE_RE.test(value.trim())) console.log(`${pad}string (https image URL): ${value.trim()}`);
    else console.log(`${pad}string (not an image URL, value withheld), length=${value.length}`);
    return;
  }
  if (Array.isArray(value)) {
    console.log(`${pad}array, length=${value.length}`);
    value.slice(0, 3).forEach((item, i) => {
      console.log(`${pad}  item[${i}]: type=${typeOf(item)}`);
      if (item && typeof item === "object" && !Array.isArray(item)) {
        console.log(`${pad}    keys: [${Object.keys(item).join(", ")}]`);
        for (const key of IMAGE_URL_KEYS) {
          if (typeof item[key] === "string") {
            console.log(`${pad}    recognized URL field "${key}": ${HTTPS_IMAGE_RE.test(item[key].trim()) ? item[key].trim() : "(present, but not an https image URL)"}`);
          }
        }
      } else if (typeof item === "string") {
        describeValue(item, indent + 2);
      }
    });
    if (value.length > 3) console.log(`${pad}  ... (${value.length - 3} more items, not printed)`);
    return;
  }
  if (value && typeof value === "object") {
    console.log(`${pad}object, keys: [${Object.keys(value).join(", ")}]`);
    return;
  }
  console.log(`${pad}${typeOf(value)}`);
}

function collectRecognizedImageUrls(body) {
  const found = new Set();
  const scanArray = (arr) => {
    for (const item of arr) {
      if (typeof item === "string" && HTTPS_IMAGE_RE.test(item.trim())) found.add(item.trim());
      else if (item && typeof item === "object") {
        for (const key of IMAGE_URL_KEYS) {
          if (typeof item[key] === "string" && HTTPS_IMAGE_RE.test(item[key].trim())) found.add(item[key].trim());
        }
      }
    }
  };
  if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) {
      if (!CANDIDATE_FIELD_PATTERN.test(key)) continue;
      if (Array.isArray(value)) scanArray(value);
      else if (typeof value === "string" && HTTPS_IMAGE_RE.test(value.trim())) found.add(value.trim());
    }
    // One level deep, in case the gallery is nested (e.g. body.media.images).
    for (const value of Object.values(body)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (!CANDIDATE_FIELD_PATTERN.test(nestedKey)) continue;
          if (Array.isArray(nestedValue)) scanArray(nestedValue);
        }
      }
    }
  }
  return [...found];
}

async function main() {
  const client = createKoffClient({ email: KOFF_EMAIL, password: KOFF_PASSWORD, logger: silentLogger });
  await client.login();
  await client.ensureFreshToken();

  const path = `/api/product/${PRODUCT_ID}`;
  console.log(`GET ${path}`);
  const response = await client.request(path);
  console.log(`HTTP status: ${response.status}`);

  if (!response.ok) {
    console.log("Non-2xx response - no body will be parsed. This probe made no further requests.");
    return;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    console.log("Response was not valid JSON.");
    return;
  }

  if (!body || typeof body !== "object") {
    console.log(`Response body is not an object (type=${typeOf(body)}).`);
    return;
  }

  console.log(`\nTop-level fields: [${Object.keys(body).join(", ")}]`);

  console.log("\nCandidate image/gallery/media fields:");
  const candidateKeys = Object.keys(body).filter((key) => CANDIDATE_FIELD_PATTERN.test(key));
  if (candidateKeys.length === 0) console.log("  (none found by name at the top level)");
  for (const key of candidateKeys) {
    console.log(`  "${key}":`);
    describeValue(body[key], 2);
  }

  const urls = collectRecognizedImageUrls(body);
  console.log(`\nFinal unique HTTPS image URLs found: ${urls.length}`);
  for (const url of urls) console.log(`  ${url}`);
}

main().catch((err) => {
  // Never print err.stack/err.cause verbatim - a thrown fetch/JSON error
  // could in principle echo back request internals.
  console.error(`Probe failed: ${err.message ?? "unknown error"}`);
  process.exit(1);
});
