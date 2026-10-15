// ============================================================================
// CASEKING PRICING v2 (PM decision, 2026-10-15)
// ----------------------------------------------------------------------------
// One rule for every supplier we price ourselves (Koff, Homescreen). The same
// numbers are ported 1:1 to convex/homescreenPricing.ts; the test vectors in
// test/pricing.test.mjs are the contract both copies must pass.
//
// Owner's facts this is built on (2026-10-14/15):
//   - supplier orders go out twice a week (Mon, Thu), so a supplier's delivery
//     (Koff 10 €, PhonePlay 7 €, Homescreen 7 €) is shared by that batch;
//   - the shop pays ~3.5-4 € for an Econt parcel when delivery is free
//     (from 39.99 € to an office), otherwise the customer pays it;
//   - wanted: 8-10 € profit per order, cheap items dearer, nothing under 9.99 €.
//
// base = supplier net price x 1.23 (VAT and a small buffer, owner 2026-10-15)
//
// B2C
//   1. target profit by base:  base <= 20 €  -> max(7 €, 60% of base)
//                              20-40 €       -> 12 € rising to 14 €
//                              above 40 €    -> 30% of base, 14-30 €
//      Smooth on purpose: a dearer product never ends up cheaper than a
//      cheaper one (the old 80%/55% step did that around base 8 €).
//   2. hard floor: price >= 9.99 € and price >= base + 6 €. Never below.
//   3. shelf price: the lowest point of the price ladder that is at least
//      max(floor, target - 1 €). The ladder is 9.99, then x2.99 / x4.99 /
//      x7.99 / x9.99 up to 99.99, then every 5 €. Rounding only goes up from
//      the floor, so it never eats into the guaranteed profit.
//
// B2B (approved trade accounts only - the shop must not show these prices to
// a self-declared B2B account; see the backend task of 2026-10-15)
//   base + 25% of base, at least 1.50 € and at most 9 €, rounded UP to .99,
//   never under 1.99 €. Pure cost-plus; never above the B2C price.
// ============================================================================

export const VAT_RATE = 0.23;
export const VAT_MULTIPLIER = 1 + VAT_RATE;

export function addVat(basePrice) {
  return basePrice * VAT_MULTIPLIER;
}

export const B2C_MIN_PRICE = 9.99;
export const B2C_HARD_MIN_MARGIN = 6;
const B2C_LADDER_SHAVE = 1;

const B2B_PERCENT = 0.25;
const B2B_MIN_MARKUP = 1.5;
const B2B_MAX_MARKUP = 9;
export const B2B_MIN_PRICE = 1.99;

const cents = (value) => Math.round(value * 100) / 100;

/** The profit the shop aims for on one product, in euro, by its landed cost. */
export function targetMargin(base) {
  if (base <= 20) return Math.max(7, 0.6 * base);
  if (base <= 40) return 12 + 0.1 * (base - 20);
  return Math.min(Math.max(14, 0.3 * base), 30);
}

function buildLadder() {
  const points = [9.99];
  for (let tens = 10; tens < 100; tens += 10) {
    for (const end of [2.99, 4.99, 7.99, 9.99]) points.push(cents(tens + end));
  }
  return points;
}

export const B2C_PRICE_LADDER = Object.freeze(buildLadder());

/** The lowest allowed shelf price at or above `need`. */
function shelfPriceAtLeast(need) {
  for (const point of B2C_PRICE_LADDER) {
    if (point >= need - 1e-9) return point;
  }
  // Above 99.99: every 5 € (x4.99 / x9.99).
  const step = Math.ceil((need + 0.01 - 1e-9) / 5) * 5;
  return cents(step - 0.01);
}

export function calcB2CPrice(basePrice) {
  const target = basePrice + targetMargin(basePrice);
  const floor = Math.max(B2C_MIN_PRICE, basePrice + B2C_HARD_MIN_MARGIN);
  return shelfPriceAtLeast(Math.max(floor, target - B2C_LADDER_SHAVE));
}

export function calcB2BPrice(basePrice) {
  const markup = Math.min(Math.max(basePrice * B2B_PERCENT, B2B_MIN_MARKUP), B2B_MAX_MARKUP);
  const raw = basePrice + markup;
  // Up to the next .99 (a price already on .99 stays).
  const rounded = cents(Math.ceil(cents(raw) - 0.99 - 1e-9) + 0.99);
  const price = Math.max(rounded, B2B_MIN_PRICE);
  return Math.min(price, calcB2CPrice(basePrice));
}
