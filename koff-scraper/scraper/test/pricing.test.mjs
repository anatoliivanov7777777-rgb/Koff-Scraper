import test from "node:test";
import assert from "node:assert/strict";

import { addVat, calcB2BPrice, calcB2CPrice, targetMargin, B2C_PRICE_LADDER } from "../pricing.mjs";

// The contract. convex/homescreenPricing.ts must return exactly these.
export const VECTORS = [
  // base, B2C, B2B
  [0.01, 9.99, 1.99],
  [1.22, 9.99, 2.99],
  [2.44, 9.99, 3.99],
  [3.42, 9.99, 4.99],
  [4.68, 12.99, 6.99],
  [8.5, 14.99, 10.99],
  [10.62, 17.99, 13.99],
  [15.11, 24.99, 18.99],
  [20.21, 32.99, 25.99],
  [28.87, 42.99, 36.99],
  [39.46, 52.99, 48.99],
  [100, 129.99, 109.99],
];

test("the shared price vectors", () => {
  for (const [base, b2c, b2b] of VECTORS) {
    assert.equal(calcB2CPrice(base), b2c, `B2C for base ${base}`);
    assert.equal(calcB2BPrice(base), b2b, `B2B for base ${base}`);
  }
});

test("B2C: never under 9.99 and never under base + 6 €", () => {
  for (let base = 0.01; base < 300; base += 0.07) {
    const price = calcB2CPrice(base);
    assert.ok(price >= 9.99 - 1e-9, `base ${base}: ${price}`);
    assert.ok(price - base >= 6 - 1e-9, `base ${base}: margin ${price - base}`);
  }
});

test("B2C: a dearer product is never cheaper (no steps backwards)", () => {
  let previous = 0;
  for (let base = 0.01; base < 300; base += 0.01) {
    const price = calcB2CPrice(base);
    assert.ok(price >= previous - 1e-9, `base ${base.toFixed(2)}: ${previous} -> ${price}`);
    previous = price;
  }
});

test("B2C: prices are ladder points (or x4.99 / x9.99 above 100 €)", () => {
  for (let base = 0.01; base < 300; base += 0.13) {
    const price = calcB2CPrice(base);
    if (price <= 99.99) assert.ok(B2C_PRICE_LADDER.includes(price), `${price} not on the ladder`);
    else assert.ok([4.99, 9.99].includes(Math.round((price % 10) * 100) / 100), `${price} not x4.99/x9.99`);
  }
});

test("B2C: profit stays within 1 € of the target or above it", () => {
  for (let base = 0.01; base < 300; base += 0.11) {
    const margin = calcB2CPrice(base) - base;
    assert.ok(margin >= Math.min(targetMargin(base) - 1, targetMargin(base)) - 1e-9, `base ${base}`);
  }
});

test("B2B: 25% cost-plus, 1.50-9 € markup, .99, at least 1.99, never above B2C", () => {
  for (let base = 0.01; base < 300; base += 0.07) {
    const b2b = calcB2BPrice(base);
    assert.equal(Math.round(b2b * 100) % 100, 99);
    assert.ok(b2b >= 1.99 - 1e-9);
    assert.ok(b2b <= calcB2CPrice(base) + 1e-9);
    assert.ok(b2b - base >= Math.min(1.5, calcB2CPrice(base) - base) - 1e-9, `base ${base}`);
    assert.ok(b2b - base <= 9 + 0.99 + 1e-9, `base ${base}: B2B markup ${b2b - base}`);
  }
});

test("VAT 23% is applied before the markup", () => {
  assert.equal(Math.round(addVat(10) * 100) / 100, 12.3);
  assert.equal(calcB2CPrice(addVat(10)), 19.99);
});
