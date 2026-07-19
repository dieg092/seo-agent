// src/prioritization/heuristics.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { getHeuristic } from "./heuristics";

test("getHeuristic returns the documented impact/effort for robots-blocks-all", () => {
  const result = getHeuristic("robots-blocks-all");
  assert.equal(result.impactScore, 10);
  assert.equal(result.effortScore, 1);
});

test("getHeuristic returns a value for every FindingType without throwing", () => {
  const allTypes = [
    "sitemap-malformed",
    "sitemap-out-of-domain",
    "sitemap-fetch-failed",
    "sitemap-stale-entries",
    "sitemap-other",
    "robots-missing-sitemap-directive",
    "robots-blocks-all",
    "robots-fetch-failed",
    "robots-other",
    "structured-data-missing",
    "structured-data-invalid-json",
    "structured-data-missing-field",
    "performance-lcp-red",
    "performance-cls-red",
    "performance-inp-red",
    "performance-low-score",
  ] as const;

  for (const type of allTypes) {
    const result = getHeuristic(type);
    assert.ok(result.impactScore >= 1 && result.impactScore <= 10);
    assert.ok(result.effortScore >= 1 && result.effortScore <= 10);
  }
});

test("getHeuristic returns a value for the 4 new finding types without throwing", () => {
  const newTypes = [
    "internal-link-suggestion",
    "content-cannibalization",
    "content-declining",
    "content-query-gap",
  ] as const;

  for (const type of newTypes) {
    const result = getHeuristic(type);
    assert.ok(result.impactScore >= 1 && result.impactScore <= 10);
    assert.ok(result.effortScore >= 1 && result.effortScore <= 10);
  }
});
