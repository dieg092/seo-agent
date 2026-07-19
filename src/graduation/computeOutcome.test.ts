// src/graduation/computeOutcome.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcome } from "./computeOutcome";

test("computeOutcome returns negative when clicks drop 15% or more", () => {
  assert.equal(computeOutcome(100, 84), "negative");
  assert.equal(computeOutcome(100, 85), "negative");
});

test("computeOutcome returns positive when clicks hold steady or improve", () => {
  assert.equal(computeOutcome(100, 86), "positive");
  assert.equal(computeOutcome(100, 100), "positive");
  assert.equal(computeOutcome(100, 150), "positive");
});

test("computeOutcome returns inconclusive when there is no baseline to compare against", () => {
  assert.equal(computeOutcome(0, 0), "inconclusive");
  assert.equal(computeOutcome(0, 5), "inconclusive");
});
