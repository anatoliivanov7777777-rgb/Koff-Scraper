import { test } from "node:test";
import assert from "node:assert/strict";

// Importing this module must NOT trigger a real sync (main() is guarded to
// only run when the file is executed directly). This file only checks
// that exporting resolveCategorySlug (for the Phase E read-only analysis
// tool) did not change its behavior in any way - no logic was modified.
process.env.CASEKING_CONVEX_URL = "https://elated-butterfly-122.eu-west-1.convex.cloud";

const { resolveCategorySlug } = await import("../sync-caseking.mjs");

test("resolveCategorySlug is now exported and still maps a known category exactly as before", () => {
  assert.equal(resolveCategorySlug({ category: "CamShield Series" }), "keysove-i-kalufi");
  assert.equal(resolveCategorySlug({ category: "Powerbanks" }), "vanshni-baterii");
  assert.equal(resolveCategorySlug({ category: "Car Chargers" }), "aksesoari-za-avtomobili");
});

test("resolveCategorySlug still resolves EXTRA_CATEGORY_MAP entries unchanged", () => {
  assert.equal(resolveCategorySlug({ category: "Memory cards" }), "memory_cards");
  assert.equal(resolveCategorySlug({ category: "Jack 3.5mm" }), "audio_cables");
});

test("resolveCategorySlug still returns null for an unmapped category", () => {
  assert.equal(resolveCategorySlug({ category: "Some Unmapped Category" }), null);
});

test("resolveCategorySlug still redirects hydrogel-named screen protectors to hydrogel_film", () => {
  assert.equal(
    resolveCategorySlug({ category: "Tempered Glass", name: "Nillkin - Hydrogel Film - iPhone 16" }),
    "hydrogel_film"
  );
  assert.equal(resolveCategorySlug({ category: "Tempered Glass", name: "Nillkin - Glass - iPhone 16" }), "protektori-za-ekran");
});
