import { test } from "node:test";
import assert from "node:assert/strict";
import { auditStructuredData } from "./structuredDataAuditor";

const HTML_WITH_VALID_ARTICLE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article","headline":"Ejemplo","author":{"@type":"Person","name":"Ana"},"datePublished":"2026-01-01"}
</script>
</head><body></body></html>`;

const HTML_WITH_INCOMPLETE_ARTICLE = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Article"}
</script>
</head><body></body></html>`;

const HTML_WITHOUT_JSONLD = `<html><head></head><body>sin datos estructurados</body></html>`;

test("auditStructuredData validates a well-formed Article block", async () => {
  const [entry] = await auditStructuredData({
    urls: ["https://miwebdeboda.com/blog/categoria/ejemplo"],
    fetchHtml: async () => HTML_WITH_VALID_ARTICLE,
  });

  assert.equal(entry.schemaType, "Article");
  assert.equal(entry.isValid, true);
  assert.deepEqual(entry.errors, []);
});

test("auditStructuredData flags missing required fields", async () => {
  const [entry] = await auditStructuredData({
    urls: ["https://miwebdeboda.com/blog/categoria/incompleto"],
    fetchHtml: async () => HTML_WITH_INCOMPLETE_ARTICLE,
  });

  assert.equal(entry.isValid, false);
  assert.ok(entry.errors.some((e) => e.includes("headline")));
  assert.ok(entry.errors.some((e) => e.includes("author")));
  assert.ok(entry.errors.some((e) => e.includes("datePublished")));
});

test("auditStructuredData flags pages with no JSON-LD at all", async () => {
  const [entry] = await auditStructuredData({
    urls: ["https://miwebdeboda.com/pagina-sin-datos"],
    fetchHtml: async () => HTML_WITHOUT_JSONLD,
  });

  assert.equal(entry.schemaType, "none");
  assert.equal(entry.isValid, false);
  assert.ok(entry.errors.some((e) => e.includes("No se encontró")));
});
