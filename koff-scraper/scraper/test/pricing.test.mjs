import test from "node:test";
import assert from "node:assert/strict";

import { addVat, calcB2BPrice, calcB2CPrice } from "../pricing.mjs";

test("B2B rounds to nearest .99 while keeping 45% base markup bounds", () => {
  assert.equal(calcB2BPrice(5), 6.99);      // target 7.25 -> down
  assert.equal(calcB2BPrice(10), 14.99);   // target 14.50 -> up
  assert.equal(calcB2BPrice(0.5), 1.99);   // 0.99 would violate €0.60 minimum
  assert.equal(calcB2BPrice(100), 107.99); // respects €8 maximum
});

test("B2C rounds to nearest .99 while keeping 80% base markup bounds", () => {
  assert.equal(calcB2CPrice(5), 8.99);      // target 9.00 -> down
  assert.equal(calcB2CPrice(10), 17.99);    // target 18.00 -> down
  assert.equal(calcB2CPrice(0.5), 2.99);    // 1.99 would violate €2 minimum
  assert.equal(calcB2CPrice(100), 111.99);  // respects €12 maximum
});

test("all returned prices end in .99 and stay inside configured markup bounds", () => {
  const samples = [0.01, 0.25, 0.5, 1, 2.5, 5, 10, 15, 25, 50, 100, 250];

  for (const base of samples) {
    const b2b = calcB2BPrice(base);
    const b2c = calcB2CPrice(base);

    assert.equal(Math.round(b2b * 100) % 100, 99);
    assert.equal(Math.round(b2c * 100) % 100, 99);

    const b2bMarkup = b2b - base;
    const b2cMarkup = b2c - base;

    assert.ok(b2bMarkup >= 0.6 - 1e-9 && b2bMarkup <= 8 + 1e-9);
    assert.ok(b2cMarkup >= 2 - 1e-9 && b2cMarkup <= 12 + 1e-9);
  }
});


test("VAT is applied before B2B/B2C markup and .99 rounding", () => {
  const net = 10;
  const gross = addVat(net);

  assert.equal(gross, 12);
  assert.equal(calcB2BPrice(gross), 16.99); // 12 + 45% = 17.40 -> nearest valid .99
  assert.equal(calcB2CPrice(gross), 21.99); // 12 + 80% = 21.60 -> nearest valid .99
});
