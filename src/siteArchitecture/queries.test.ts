// src/siteArchitecture/queries.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import {
  getTemplatePerformanceHistory,
  getNearDuplicatePairs,
  getMissingProvincialTemplateCandidates,
} from "./queries";

const TEST_ARTICLE_SLUGS = ["near-dup-a", "near-dup-b", "near-dup-c"];
const TEST_SC_QUERIES = ["fotografo boda malaga", "fotografo boda sevilla"];

// SAFETY: ArticleEmbedding and SearchConsoleSnapshot are precious/protected
// tables holding real production data (28 real article embeddings, real GSC
// history). Never run an unscoped deleteMany({}) against them — only scope
// cleanup to this test file's own distinctive test rows. PerformanceAuditResult
// is NOT precious (cheap/regenerable via the weekly PageSpeed job), so it is
// safe to wipe unconditionally in tests.
async function resetTables() {
  await prisma.performanceAuditResult.deleteMany({});
  await prisma.articleEmbedding.deleteMany({ where: { slug: { in: TEST_ARTICLE_SLUGS } } });
  await prisma.searchConsoleSnapshot.deleteMany({ where: { query: { in: TEST_SC_QUERIES } } });
}

test("getTemplatePerformanceHistory groups scores by URL across multiple runs, only including URLs with enough history", async () => {
  await resetTables();

  const url = "https://miwebdeboda.com/glosario-bodas";
  await prisma.performanceAuditResult.create({ data: { url, performanceScore: 40, runAt: new Date(Date.now() - 3 * 7 * 24 * 60 * 60 * 1000) } });
  await prisma.performanceAuditResult.create({ data: { url, performanceScore: 42, runAt: new Date(Date.now() - 2 * 7 * 24 * 60 * 60 * 1000) } });
  await prisma.performanceAuditResult.create({ data: { url, performanceScore: 38, runAt: new Date(Date.now() - 1 * 7 * 24 * 60 * 60 * 1000) } });

  const onlyOneRunUrl = "https://miwebdeboda.com/precios";
  await prisma.performanceAuditResult.create({ data: { url: onlyOneRunUrl, performanceScore: 90, runAt: new Date() } });

  const result = await getTemplatePerformanceHistory({ minRuns: 3 });

  const glosarioEntry = result.find((r) => r.url === url);
  assert.ok(glosarioEntry);
  assert.deepEqual(glosarioEntry?.scores.sort(), [38, 40, 42]);

  const preciosEntry = result.find((r) => r.url === onlyOneRunUrl);
  assert.equal(preciosEntry, undefined);

  await resetTables();
});

function makeVector(base: number[]): number[] {
  return [...base, ...new Array(1024 - base.length).fill(0)];
}

async function seedArticle(slug: string, vector: number[]) {
  const literal = `[${vector.join(",")}]`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "seo_agent"."ArticleEmbedding" ("id", "slug", "url", "contentHash", "embedding", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'hash', $3::vector, now())`,
    slug,
    `https://miwebdeboda.com/blog/${slug}`,
    literal
  );
}

test("getNearDuplicatePairs only returns pairs above the strict 0.92 threshold", async () => {
  await resetTables();

  await seedArticle("near-dup-a", makeVector([1, 0, 0]));
  await seedArticle("near-dup-b", makeVector([0.99, 0.01, 0]));
  await seedArticle("near-dup-c", makeVector([0.5, 0.5, 0]));

  const result = await getNearDuplicatePairs();

  const abPair = result.find(
    (p) => (p.slugA === "near-dup-a" && p.slugB === "near-dup-b") || (p.slugA === "near-dup-b" && p.slugB === "near-dup-a")
  );
  assert.ok(abPair, "a/b should be flagged as near-duplicates");

  const acPair = result.find(
    (p) => (p.slugA === "near-dup-a" && p.slugB === "near-dup-c") || (p.slugA === "near-dup-c" && p.slugB === "near-dup-a")
  );
  assert.equal(acPair, undefined, "a/c similarity is far below 0.92 and should not be flagged");

  await resetTables();
});

test("getMissingProvincialTemplateCandidates flags a province with real impressions and no existing page", async () => {
  await resetTables();

  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(), page: "/blog/some-article", query: "fotografo boda malaga", clicks: 5, impressions: 600, ctr: 0.008, position: 20 },
  });

  const result = await getMissingProvincialTemplateCandidates({
    fetchXml: async () => `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://miwebdeboda.com/blog/organizar-boda</loc></url>
</urlset>`,
  });

  const malagaCandidate = result.find((c) => c.province === "malaga");
  assert.ok(malagaCandidate);
  assert.equal(malagaCandidate?.impressions, 600);

  await resetTables();
});

test("getMissingProvincialTemplateCandidates does not flag a province that already has a matching page", async () => {
  await resetTables();

  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(), page: "/blog/some-article", query: "fotografo boda sevilla", clicks: 5, impressions: 600, ctr: 0.008, position: 20 },
  });

  const result = await getMissingProvincialTemplateCandidates({
    fetchXml: async () => `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://miwebdeboda.com/blog/bodas-sevilla-guia</loc></url>
</urlset>`,
  });

  const sevillaCandidate = result.find((c) => c.province === "sevilla");
  assert.equal(sevillaCandidate, undefined);

  await resetTables();
});
