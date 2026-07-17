import { test } from "node:test";
import assert from "node:assert/strict";
import { auditSitemap } from "./sitemapAuditor";

const VALID_SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://miwebdeboda.com/blog/categoria/ejemplo</loc><lastmod>${new Date().toISOString()}</lastmod></url>
  <url><loc>https://miwebdeboda.com/glosario-bodas</loc><lastmod>2024-01-01T00:00:00.000Z</lastmod></url>
</urlset>`;

test("auditSitemap counts URLs and flags entries older than 400 days as stale", async () => {
  const result = await auditSitemap({
    fetchXml: async () => VALID_SITEMAP,
    baseUrl: "https://miwebdeboda.com",
  });

  assert.equal(result.urlCount, 2);
  assert.equal(result.staleEntries, 1);
  assert.deepEqual(result.errors, []);
});

test("auditSitemap reports an error when the XML is malformed", async () => {
  const result = await auditSitemap({
    fetchXml: async () => "<urlset><url><loc>not closed",
    baseUrl: "https://miwebdeboda.com",
  });

  assert.equal(result.urlCount, 0);
  assert.ok(result.errors.length > 0);
});

test("auditSitemap reports an error when a URL doesn't match the site's own domain", async () => {
  const result = await auditSitemap({
    fetchXml: async () => `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://otro-dominio.com/pagina</loc></url>
</urlset>`,
    baseUrl: "https://miwebdeboda.com",
  });

  assert.ok(result.errors.some((e) => e.includes("otro-dominio.com")));
});
