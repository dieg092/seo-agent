// src/prioritization/stableKey.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStableKey } from "./stableKey";
import type { Finding } from "./types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "sitemap",
    findingType: "sitemap-malformed",
    stableKeyInput: "sitemap-malformed",
    title: "t",
    detail: null,
    sourceRefId: "row-1",
    ...overrides,
  };
}

test("computeStableKey is deterministic for the same finding", () => {
  const a = computeStableKey(makeFinding());
  const b = computeStableKey(makeFinding());
  assert.equal(a, b);
});

test("computeStableKey differs when stableKeyInput differs", () => {
  const a = computeStableKey(makeFinding({ stableKeyInput: "a" }));
  const b = computeStableKey(makeFinding({ stableKeyInput: "b" }));
  assert.notEqual(a, b);
});

test("computeStableKey differs across sources even with the same stableKeyInput", () => {
  const a = computeStableKey(makeFinding({ source: "sitemap", stableKeyInput: "x" }));
  const b = computeStableKey(makeFinding({ source: "robots", stableKeyInput: "x" }));
  assert.notEqual(a, b);
});

test("computeStableKey is unaffected by sourceRefId (the row that detected it, not the finding's identity)", () => {
  const a = computeStableKey(makeFinding({ sourceRefId: "row-1" }));
  const b = computeStableKey(makeFinding({ sourceRefId: "row-2" }));
  assert.equal(a, b);
});
