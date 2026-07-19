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

test("internal-link-suggestion is always Tier 2 (never Tier 1 — no deterministic fixer for prose edits)", () => {
  assert.equal(getTier("internal-link-suggestion"), 2);
});

test("content opportunity finding types are always Tier 3 (always human, via the editorial calendar)", () => {
  assert.equal(getTier("content-cannibalization"), 3);
  assert.equal(getTier("content-declining"), 3);
  assert.equal(getTier("content-query-gap"), 3);
});

test("all 3 site-architecture finding types are always Tier 3 (strategic decisions, never auto-applied or Opus-decided)", () => {
  assert.equal(getTier("site-architecture-template-performance"), 3);
  assert.equal(getTier("site-architecture-near-duplicate"), 3);
  assert.equal(getTier("site-architecture-missing-template"), 3);
});
