// src/prioritization/classify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSitemapFindings,
  extractRobotsFindings,
  extractStructuredDataFindings,
  extractPerformanceFindings,
  extractInternalLinkFindings,
  extractCannibalizationFindings,
  extractDecliningFindings,
  extractQueryGapFindings,
  extractSiteArchitectureFindings,
  extractLowCtrFindings,
  extractNearPage1Findings,
  extractHighImpressionLowPositionFindings,
} from "./classify";

test("extractSitemapFindings classifies a malformed-XML error", () => {
  const findings = extractSitemapFindings({
    id: "row-1",
    errors: ["El XML del sitemap parece estar mal formado (no se encontró </urlset>)"],
    staleEntries: 0,
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "sitemap-malformed");
  assert.equal(findings[0].source, "sitemap");
  assert.equal(findings[0].sourceRefId, "row-1");
});

test("extractSitemapFindings classifies an out-of-domain URL error, keyed per URL", () => {
  const findings = extractSitemapFindings({
    id: "row-2",
    errors: [
      "URL fuera de dominio en el sitemap: https://otro-dominio.com/a",
      "URL fuera de dominio en el sitemap: https://otro-dominio.com/b",
    ],
    staleEntries: 0,
  });

  assert.equal(findings.length, 2);
  assert.equal(findings[0].findingType, "sitemap-out-of-domain");
  assert.notEqual(findings[0].stableKeyInput, findings[1].stableKeyInput);
});

test("extractSitemapFindings adds one aggregate finding when staleEntries > 0", () => {
  const findings = extractSitemapFindings({ id: "row-3", errors: [], staleEntries: 5 });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "sitemap-stale-entries");
  assert.ok(findings[0].title.includes("5"));
});

test("extractSitemapFindings returns nothing when there are no errors and no stale entries", () => {
  const findings = extractSitemapFindings({ id: "row-4", errors: [], staleEntries: 0 });
  assert.equal(findings.length, 0);
});

test("extractRobotsFindings classifies the missing-sitemap-directive error", () => {
  const findings = extractRobotsFindings({
    id: "row-5",
    errors: ["robots.txt no declara ninguna directiva Sitemap:"],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "robots-missing-sitemap-directive");
});

test("extractRobotsFindings classifies the blocks-all error", () => {
  const findings = extractRobotsFindings({
    id: "row-6",
    errors: ["robots.txt contiene 'Disallow: /' — bloquearía la indexación de todo el sitio"],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "robots-blocks-all");
});

test("extractStructuredDataFindings skips valid rows and classifies invalid ones", () => {
  const findings = extractStructuredDataFindings([
    { id: "sd-1", url: "https://miwebdeboda.com", schemaType: "Organization", isValid: true, errors: [] },
    { id: "sd-2", url: "https://miwebdeboda.com/blog", schemaType: "none", isValid: false, errors: ["No se encontró ningún bloque JSON-LD en la página"] },
    { id: "sd-3", url: "https://miwebdeboda.com/glosario-bodas", schemaType: "DefinedTermSet", isValid: false, errors: ['Falta el campo requerido "name" para el tipo DefinedTermSet'] },
  ]);

  assert.equal(findings.length, 2);
  const missing = findings.find((f) => f.findingType === "structured-data-missing");
  const missingField = findings.find((f) => f.findingType === "structured-data-missing-field");
  assert.ok(missing);
  assert.ok(missingField);
  assert.equal(missing?.sourceRefId, "sd-2");
  assert.equal(missingField?.sourceRefId, "sd-3");
});

test("extractPerformanceFindings flags each breached metric separately", () => {
  const findings = extractPerformanceFindings([
    { id: "perf-1", url: "https://miwebdeboda.com/blog", performanceScore: 31, lcp: 5.2, cls: 0.4, inp: 650 },
  ]);

  const types = findings.map((f) => f.findingType).sort();
  assert.deepEqual(types, [
    "performance-cls-red",
    "performance-inp-red",
    "performance-lcp-red",
    "performance-low-score",
  ]);
});

test("extractPerformanceFindings returns nothing for a healthy page", () => {
  const findings = extractPerformanceFindings([
    { id: "perf-2", url: "https://miwebdeboda.com", performanceScore: 92, lcp: 1.8, cls: 0.05, inp: 180 },
  ]);

  assert.equal(findings.length, 0);
});

test("extractInternalLinkFindings creates one finding per open link suggestion", () => {
  const findings = extractInternalLinkFindings([
    { id: "ls-1", sourceSlug: "invitaciones/como-elegir", targetSlug: "presupuesto/cuanto-cuesta", similarity: 0.62 },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "internal-link-suggestion");
  assert.equal(findings[0].source, "internalLinking");
  assert.equal(findings[0].sourceRefId, "ls-1");
  assert.ok(findings[0].stableKeyInput.includes("invitaciones/como-elegir"));
  assert.ok(findings[0].stableKeyInput.includes("presupuesto/cuanto-cuesta"));
});

test("extractCannibalizationFindings flags a query with 2+ pages and no clear winner", () => {
  const findings = extractCannibalizationFindings([
    { page: "/blog/a", query: "invitaciones de boda baratas", date: new Date("2026-07-01") },
    { page: "/blog/b", query: "invitaciones de boda baratas", date: new Date("2026-07-01") },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "content-cannibalization");
  assert.equal(findings[0].source, "content");
});

test("extractCannibalizationFindings does not flag a query with only 1 page", () => {
  const findings = extractCannibalizationFindings([
    { page: "/blog/a", query: "unica pagina", date: new Date("2026-07-01") },
  ]);

  assert.equal(findings.length, 0);
});

test("extractDecliningFindings flags a page whose clicks dropped 30%+ vs. the prior period", () => {
  const findings = extractDecliningFindings(
    [{ page: "/blog/a", clicks: 7 }],
    [{ page: "/blog/a", clicks: 10 }]
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "content-declining");
});

test("extractDecliningFindings does not flag a page with a small or no decline", () => {
  const findings = extractDecliningFindings(
    [{ page: "/blog/a", clicks: 9 }],
    [{ page: "/blog/a", clicks: 10 }]
  );

  assert.equal(findings.length, 0);
});

test("extractQueryGapFindings flags high-impression, low-CTR, low-position queries", () => {
  const findings = extractQueryGapFindings([
    { page: "/blog/a", query: "cuanto cuesta una boda", impressions: 5000, clicks: 20, position: 15 },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "content-query-gap");
});

test("extractQueryGapFindings does not flag a query that's already ranking well", () => {
  const findings = extractQueryGapFindings([
    { page: "/blog/a", query: "bien posicionada", impressions: 5000, clicks: 500, position: 3 },
  ]);

  assert.equal(findings.length, 0);
});

test("extractSiteArchitectureFindings flags a template with consistently low performance scores", () => {
  const findings = extractSiteArchitectureFindings({
    templatePerformance: [{ url: "https://miwebdeboda.com/glosario-bodas", scores: [38, 40, 42] }],
    nearDuplicates: [],
    missingTemplates: [],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "site-architecture-template-performance");
  assert.equal(findings[0].source, "siteArchitecture");
});

test("extractSiteArchitectureFindings does not flag a template with healthy performance scores", () => {
  const findings = extractSiteArchitectureFindings({
    templatePerformance: [{ url: "https://miwebdeboda.com/glosario-bodas", scores: [85, 90, 88] }],
    nearDuplicates: [],
    missingTemplates: [],
  });

  assert.equal(findings.length, 0);
});

test("extractSiteArchitectureFindings creates one finding per near-duplicate pair", () => {
  const findings = extractSiteArchitectureFindings({
    templatePerformance: [],
    nearDuplicates: [{ slugA: "a", slugB: "b", similarity: 0.95 }],
    missingTemplates: [],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "site-architecture-near-duplicate");
});

test("extractSiteArchitectureFindings creates one finding per missing-template candidate", () => {
  const findings = extractSiteArchitectureFindings({
    templatePerformance: [],
    nearDuplicates: [],
    missingTemplates: [{ province: "malaga", impressions: 600 }],
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "site-architecture-missing-template");
});

test("extractLowCtrFindings flags a page ranking 1-10 with CTR below 60% of expected", () => {
  // posición 5 → CTR esperado 6%; 60% de eso es 3.6%. Con 0 clics de 25
  // impresiones el CTR real es 0%, muy por debajo del umbral.
  const findings = extractLowCtrFindings([
    { page: "/blog/a", impressions: 25, clicks: 0, avgPosition: 5 },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "content-low-ctr");
  assert.equal(findings[0].source, "content");
  assert.equal(findings[0].sourceRefId, "/blog/a");
});

test("extractLowCtrFindings does not flag a page whose CTR already meets or beats expectations", () => {
  const findings = extractLowCtrFindings([
    { page: "/blog/a", impressions: 25, clicks: 2, avgPosition: 5 }, // 8% CTR, esperado 6%
  ]);

  assert.equal(findings.length, 0);
});

test("extractLowCtrFindings ignores pages below the impressions floor even with a real CTR gap", () => {
  const findings = extractLowCtrFindings([
    { page: "/blog/a", impressions: 15, clicks: 0, avgPosition: 5 },
  ]);

  assert.equal(findings.length, 0);
});

test("extractLowCtrFindings ignores pages outside the position 1-10 band", () => {
  const findings = extractLowCtrFindings([
    { page: "/blog/a", impressions: 100, clicks: 0, avgPosition: 15 },
  ]);

  assert.equal(findings.length, 0);
});

test("extractNearPage1Findings flags a page in position 11-20 with enough impressions and a non-declining trend", () => {
  const findings = extractNearPage1Findings(
    [{ page: "/blog/a", impressions: 40, avgPosition: 14 }],
    [{ page: "/blog/a", impressions: 35 }]
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "content-near-page1");
});

test("extractNearPage1Findings treats a page with no prior-period data as trend ok (new/growing)", () => {
  const findings = extractNearPage1Findings([{ page: "/blog/a", impressions: 40, avgPosition: 14 }], []);

  assert.equal(findings.length, 1);
});

test("extractNearPage1Findings does not flag a page whose impressions are declining", () => {
  const findings = extractNearPage1Findings(
    [{ page: "/blog/a", impressions: 30, avgPosition: 14 }],
    [{ page: "/blog/a", impressions: 60 }]
  );

  assert.equal(findings.length, 0);
});

test("extractNearPage1Findings ignores pages below the impressions floor", () => {
  const findings = extractNearPage1Findings([{ page: "/blog/a", impressions: 20, avgPosition: 14 }], []);

  assert.equal(findings.length, 0);
});

test("extractNearPage1Findings ignores pages outside the position 11-20 band", () => {
  const findings = extractNearPage1Findings([{ page: "/blog/a", impressions: 40, avgPosition: 8 }], []);

  assert.equal(findings.length, 0);
});

test("extractHighImpressionLowPositionFindings flags a page in position 21-40 with 75+ impressions", () => {
  const findings = extractHighImpressionLowPositionFindings([
    { page: "/blog/a", impressions: 80, avgPosition: 30 },
  ]);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].findingType, "content-high-impression-low-position");
});

test("extractHighImpressionLowPositionFindings ignores pages below the impressions floor", () => {
  const findings = extractHighImpressionLowPositionFindings([
    { page: "/blog/a", impressions: 50, avgPosition: 30 },
  ]);

  assert.equal(findings.length, 0);
});

test("extractHighImpressionLowPositionFindings ignores pages outside the position 21-40 band", () => {
  const findings = extractHighImpressionLowPositionFindings([
    { page: "/blog/a", impressions: 200, avgPosition: 45 },
  ]);

  assert.equal(findings.length, 0);
});
