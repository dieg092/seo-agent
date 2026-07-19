import { test } from "node:test";
import assert from "node:assert/strict";
import { getTier } from "./tierAssignment";
import type { FindingType } from "../prioritization/types";

test("robots findings that have a safe deterministic fixer are Tier 1", () => {
  assert.equal(getTier("robots-missing-sitemap-directive"), 1);
  assert.equal(getTier("robots-blocks-all"), 1);
});

test("every other FindingType is Tier 2 or Tier 3, never Tier 1", () => {
  const nonTier1: FindingType[] = [
    "sitemap-malformed",
    "sitemap-out-of-domain",
    "sitemap-fetch-failed",
    "sitemap-stale-entries",
    "sitemap-other",
    "robots-fetch-failed",
    "robots-other",
    "structured-data-missing",
    "structured-data-invalid-json",
    "structured-data-missing-field",
    "performance-lcp-red",
    "performance-cls-red",
    "performance-inp-red",
    "performance-low-score",
  ];

  for (const type of nonTier1) {
    const tier = getTier(type);
    assert.ok(tier === 2 || tier === 3, `${type} should be Tier 2 or 3, got ${tier}`);
  }
});
