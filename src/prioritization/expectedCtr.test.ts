// src/prioritization/expectedCtr.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedCtrForPosition } from "./expectedCtr";

test("expectedCtrForPosition returns the documented value for position 1", () => {
  assert.equal(expectedCtrForPosition(1), 0.27);
});

test("expectedCtrForPosition returns the documented value for position 3", () => {
  assert.equal(expectedCtrForPosition(3), 0.11);
});

test("expectedCtrForPosition returns the documented value for position 10", () => {
  assert.equal(expectedCtrForPosition(10), 0.025);
});

test("expectedCtrForPosition rounds a fractional position up to the next curve bucket", () => {
  // posición media 4.2 no es ni posición 4 ni 5 tal cual: usamos el siguiente
  // punto de la curva (5) como estimación conservadora de lo que cabe esperar.
  assert.equal(expectedCtrForPosition(4.2), 0.06);
});

test("expectedCtrForPosition returns 1.5% for positions 11-15", () => {
  assert.equal(expectedCtrForPosition(12), 0.015);
});

test("expectedCtrForPosition returns 1% for positions 16-20", () => {
  assert.equal(expectedCtrForPosition(18), 0.01);
});

test("expectedCtrForPosition returns 0.5% for positions 21-30", () => {
  assert.equal(expectedCtrForPosition(25), 0.005);
});

test("expectedCtrForPosition floors out at 0.5% beyond position 30", () => {
  assert.equal(expectedCtrForPosition(80), 0.005);
});
