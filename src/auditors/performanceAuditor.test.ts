import { test } from "node:test";
import assert from "node:assert/strict";
import { auditPerformance } from "./performanceAuditor";

const FAKE_PSI_RESPONSE_GOOD = {
  lighthouseResult: {
    categories: { performance: { score: 0.92 } },
    audits: {
      "largest-contentful-paint": { numericValue: 1800 },
      "cumulative-layout-shift": { numericValue: 0.05 },
    },
  },
  loadingExperience: {
    metrics: {
      INTERACTION_TO_NEXT_PAINT: { percentile: 180 },
    },
  },
};

const FAKE_PSI_RESPONSE_BAD = {
  lighthouseResult: {
    categories: { performance: { score: 0.31 } },
    audits: {
      "largest-contentful-paint": { numericValue: 5200 },
      "cumulative-layout-shift": { numericValue: 0.4 },
    },
  },
  loadingExperience: {
    metrics: {
      INTERACTION_TO_NEXT_PAINT: { percentile: 650 },
    },
  },
};

test("auditPerformance extracts score and Core Web Vitals from a healthy page", async () => {
  const [entry] = await auditPerformance({
    urls: ["https://miwebdeboda.com"],
    fetchPsi: async () => FAKE_PSI_RESPONSE_GOOD,
  });

  assert.equal(entry.url, "https://miwebdeboda.com");
  assert.equal(entry.performanceScore, 92);
  assert.equal(entry.lcp, 1.8);
  assert.equal(entry.cls, 0.05);
  assert.equal(entry.inp, 180);
  assert.deepEqual(entry.errors, []);
});

test("auditPerformance extracts a poor-performing page's metrics without throwing", async () => {
  const [entry] = await auditPerformance({
    urls: ["https://miwebdeboda.com/blog"],
    fetchPsi: async () => FAKE_PSI_RESPONSE_BAD,
  });

  assert.equal(entry.performanceScore, 31);
  assert.equal(entry.lcp, 5.2);
  assert.equal(entry.cls, 0.4);
  assert.equal(entry.inp, 650);
});

test("auditPerformance records an error entry when the PSI call fails, without aborting the batch", async () => {
  const entries = await auditPerformance({
    urls: ["https://miwebdeboda.com", "https://miwebdeboda.com/blog"],
    fetchPsi: async (url) => {
      if (url.includes("miwebdeboda.com/blog")) throw new Error("PSI timeout");
      return FAKE_PSI_RESPONSE_GOOD;
    },
  });

  assert.equal(entries.length, 2);
  const failing = entries.find((e) => e.url === "https://miwebdeboda.com/blog");
  assert.equal(failing?.performanceScore, null);
  assert.ok(failing?.errors[0].includes("PSI timeout"));
  const passing = entries.find((e) => e.url === "https://miwebdeboda.com");
  assert.equal(passing?.performanceScore, 92);
});
