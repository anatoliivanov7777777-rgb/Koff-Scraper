import { test } from "node:test";
import assert from "node:assert/strict";

// Собственикът, 2026-10-01: "Продукти, които не са в наличност задължително
// трябва да се махат от сайта." Sync-ът пипа само редовете, които СА в feed-а;
// тази стъпка (G5 1a) нулира наличността на редовете, които вече не са.
//
// Pure functions only - no network, no Convex, no Koff. Importing the module
// must not run a sync (main() is guarded at the bottom of sync-caseking.mjs).
process.env.CASEKING_CONVEX_URL = "https://aware-toucan-771.eu-west-1.convex.cloud";

const { feedStockChanges, isFeedDrop } = await import("../sync-caseking.mjs");

const FEED = new Set([
  "koff-sync:KF1:keysove-i-kalufi:Apple:iPhone 16 Pro Max",
  "koff-sync:KF2:keysove-i-kalufi:Samsung:Galaxy S25",
]);

test("a row whose sourceKey is in this run's feed is never a candidate", () => {
  const { toZero, missingSourceKey, alreadyZero } = feedStockChanges(
    [
      { productId: "p1", sourceKey: "koff-sync:KF1:keysove-i-kalufi:Apple:iPhone 16 Pro Max", stock: 5 },
      { productId: "p2", sourceKey: "koff-sync:KF2:keysove-i-kalufi:Samsung:Galaxy S25", stock: 0 },
    ],
    FEED
  );
  assert.deepEqual(toZero, []);
  assert.deepEqual(missingSourceKey, []);
  assert.equal(alreadyZero, 0);
});

test("a row the supplier no longer lists is zeroed - with the identity it was read under", () => {
  const { toZero, alreadyZero } = feedStockChanges(
    [
      { productId: "p3", sourceKey: "koff-sync:KF9:keysove-i-kalufi:Apple:iPhone 15", stock: 7 },
      // Stock never verified by the supplier (field absent): still "not in the
      // feed", and the owner's rule is explicit that it must get 0.
      { productId: "p4", sourceKey: "koff-sync:KF8:keysove-i-kalufi:Apple:iPhone 14", stock: null },
      { productId: "p5", sourceKey: "koff-sync:KF7:keysove-i-kalufi:Apple:iPhone 13" },
      // Already zero: nothing to write (idempotency), and not a skip either.
      { productId: "p6", sourceKey: "koff-sync:KF6:keysove-i-kalufi:Apple:iPhone 12", stock: 0 },
    ],
    FEED
  );

  assert.deepEqual(toZero, [
    { productId: "p3", expectedSourceKey: "koff-sync:KF9:keysove-i-kalufi:Apple:iPhone 15" },
    { productId: "p4", expectedSourceKey: "koff-sync:KF8:keysove-i-kalufi:Apple:iPhone 14" },
    { productId: "p5", expectedSourceKey: "koff-sync:KF7:keysove-i-kalufi:Apple:iPhone 13" },
  ]);
  assert.equal(alreadyZero, 1);
});

test("a row without a usable sourceKey is reported, never zeroed", () => {
  const { toZero, missingSourceKey } = feedStockChanges(
    [
      { productId: "p7", sourceKey: null, stock: 4 },
      { productId: "p8", stock: 4 },
      { productId: "p9", sourceKey: "", stock: 4 },
      { productId: "p10", sourceKey: 12345, stock: 4 },
    ],
    FEED
  );
  // An empty feed must not turn "no identity" into "not in the feed".
  assert.deepEqual(toZero, []);
  assert.deepEqual(missingSourceKey, ["p7", "p8", "p9", "p10"]);
});

test("an empty feed puts every identified row in the candidate list", () => {
  const { toZero } = feedStockChanges(
    [{ productId: "p1", sourceKey: "koff-sync:KF1:x:y:z", stock: 2 }],
    new Set()
  );
  assert.deepEqual(toZero, [{ productId: "p1", expectedSourceKey: "koff-sync:KF1:x:y:z" }]);
});

test("the 90% safety stop fires only on a real drop", () => {
  // First run ever: no baseline, nothing to compare against.
  assert.equal(isFeedDrop(34000, null), false);
  assert.equal(isFeedDrop(34000, undefined), false);
  assert.equal(isFeedDrop(34000, 0), false);
  assert.equal(isFeedDrop(34000, NaN), false);

  // Stable or growing feed.
  assert.equal(isFeedDrop(34000, 34000), false);
  assert.equal(isFeedDrop(35000, 34000), false);

  // Exactly 90% is not "below 90%".
  assert.equal(isFeedDrop(30600, 34000), false);
  // A broken/partial download is caught...
  assert.equal(isFeedDrop(30599, 34000), true);
  assert.equal(isFeedDrop(12000, 34000), true);
  assert.equal(isFeedDrop(0, 34000), true);
});
