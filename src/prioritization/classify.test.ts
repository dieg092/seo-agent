// src/prioritization/classify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSitemapFindings,
  extractRobotsFindings,
  extractStructuredDataFindings,
  extractPerformanceFindings,
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
