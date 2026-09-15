import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePublicMaker } from "../public-maker.mjs";

test("manufacturer=Techsuit -> publicMaker=CaseKing, rebranded", () => {
  const result = resolvePublicMaker({ manufacturer: "Techsuit", rawName: "Techsuit - CamShield Pro - iPhone 16 - Black" });
  assert.equal(result.publicMaker, "CaseKing");
  assert.equal(result.supplierMaker, "Techsuit");
  assert.equal(result.rebranded, true);
});

test("manufacturer casing/whitespace variants still match exactly (\" techSUIT \")", () => {
  const result = resolvePublicMaker({ manufacturer: " techSUIT ", rawName: "irrelevant" });
  assert.equal(result.publicMaker, "CaseKing");
  assert.equal(result.rebranded, true);
});

test("manufacturer=Spigen -> publicMaker=Spigen, not rebranded", () => {
  const result = resolvePublicMaker({ manufacturer: "Spigen", rawName: "Spigen - Liquid Air - iPhone 16 - Black" });
  assert.equal(result.publicMaker, "Spigen");
  assert.equal(result.supplierMaker, "Spigen");
  assert.equal(result.rebranded, false);
});

test("missing manufacturer + rawName starts exactly with \"Techsuit - ...\" -> CaseKing (fallback)", () => {
  const result = resolvePublicMaker({ manufacturer: undefined, rawName: "Techsuit - CamShield Pro - iPhone 16 - Black" });
  assert.equal(result.publicMaker, "CaseKing");
  assert.equal(result.rebranded, true);
});

test("missing manufacturer + rawName contains Techsuit only mid-string -> NOT rebranded", () => {
  const result = resolvePublicMaker({
    manufacturer: undefined,
    rawName: "OtherBrand - Compatible with Techsuit cases - Black",
  });
  assert.notEqual(result.publicMaker, "CaseKing");
  assert.equal(result.rebranded, false);
});

test("manufacturer=OtherBrand wins even when the name starts/contains Techsuit - manufacturer is authoritative", () => {
  const result = resolvePublicMaker({
    manufacturer: "OtherBrand",
    rawName: "Techsuit - Compatible accessory - Black",
  });
  assert.equal(result.publicMaker, "OtherBrand");
  assert.equal(result.rebranded, false);
});

test("publicMaker is omitted (undefined) when no maker can be reliably determined - never guessed", () => {
  const result = resolvePublicMaker({ manufacturer: undefined, rawName: "Generic Universal Cable - Black" });
  assert.equal(result.publicMaker, undefined);
  assert.equal(result.supplierMaker, undefined);
  assert.equal(result.rebranded, false);
});

test("empty-string manufacturer is treated as missing, not as a literal empty maker - and the name-based fallback ONLY ever detects Techsuit, never any other brand", () => {
  const result = resolvePublicMaker({ manufacturer: "   ", rawName: "Spigen - Liquid Air - iPhone 16" });
  // Rule 2 is a Techsuit-only detector, not a general "infer the maker
  // from the name" fallback - a non-Techsuit leading token must never be
  // guessed as the publicMaker.
  assert.equal(result.publicMaker, undefined);
  assert.equal(result.rebranded, false);
});

test("empty-string manufacturer with a Techsuit leading token still rebrands via the name fallback", () => {
  const result = resolvePublicMaker({ manufacturer: "   ", rawName: "Techsuit - CamShield Pro - iPhone 16 - Black" });
  assert.equal(result.publicMaker, "CaseKing");
  assert.equal(result.rebranded, true);
});

test("no blind global 'Techsuit' substring replace exists: a mid-string Techsuit mention with a real manufacturer never flips rebranded", () => {
  const result = resolvePublicMaker({
    manufacturer: "UAG",
    rawName: "UAG - Techsuit-compatible mount - Black",
  });
  assert.equal(result.publicMaker, "UAG");
  assert.equal(result.rebranded, false);
});

test("does not mutate its input object", () => {
  const input = Object.freeze({ manufacturer: "Techsuit", rawName: "Techsuit - Line - Model - Black" });
  const snapshot = { ...input };
  resolvePublicMaker(input);
  assert.deepEqual({ ...input }, snapshot);
});
