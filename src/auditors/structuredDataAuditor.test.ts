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

const HTML_WITH_ARRAY_JSONLD = `<html><head>
<script type="application/ld+json">[{"@context":"https://schema.org","@type":"Organization","name":"miwebdeboda.com"},{"@context":"https://schema.org","@type":"WebSite","name":"miwebdeboda.com","url":"https://miwebdeboda.com"}]</script>
</head><body></body></html>`;

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

test("auditStructuredData validates each object inside an array-shaped JSON-LD block separately", async () => {
  const results = await auditStructuredData({
    urls: ["https://miwebdeboda.com/"],
    fetchHtml: async () => HTML_WITH_ARRAY_JSONLD,
  });

  assert.equal(results.length, 2);

  const organization = results.find((r) => r.schemaType === "Organization");
  const website = results.find((r) => r.schemaType === "WebSite");

  assert.ok(organization, "Organization entry should be reported separately");
  assert.ok(website, "WebSite entry should be reported separately");

  assert.equal(organization!.isValid, false);
  assert.ok(organization!.errors.some((e) => e.includes(`Falta el campo requerido "url" para el tipo Organization`)));

  assert.equal(website!.isValid, true);
  assert.deepEqual(website!.errors, []);
});
