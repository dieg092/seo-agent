// src/tier2/generateBriefing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { generateBriefing } from "./generateBriefing";

// Opportunity holds real, currently-open production findings synced from live audits.
// Back up and restore instead of wiping unscoped.
async function withEmptyOpportunities<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.opportunity.findMany({});
  await prisma.opportunity.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.opportunity.deleteMany({});
    if (backup.length > 0) {
      await prisma.opportunity.createMany({ data: backup });
    }
  }
}

// ArticleEmbedding's "embedding" column is a Prisma Unsupported("vector") type, invisible
// to findMany/createMany, so it must be backed up/restored via raw SQL (casting vector
// <-> text) to avoid silently dropping the vector itself.
type ArticleEmbeddingRawRow = {
  id: string;
  slug: string;
  url: string;
  contentHash: string;
  embedding: string | null;
  updatedAt: Date;
};

async function withEmptyArticleEmbeddings<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.$queryRawUnsafe<ArticleEmbeddingRawRow[]>(
    `SELECT id, slug, url, "contentHash", embedding::text AS embedding, "updatedAt" FROM "seo_agent"."ArticleEmbedding"`
  );
  await prisma.articleEmbedding.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.articleEmbedding.deleteMany({});
    await prisma.$transaction(
      backup.map((row) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "seo_agent"."ArticleEmbedding" ("id", "slug", "url", "contentHash", "embedding", "updatedAt") VALUES ($1, $2, $3, $4, $5::vector, $6)`,
          row.id,
          row.slug,
          row.url,
          row.contentHash,
          row.embedding,
          row.updatedAt
        )
      )
    );
  }
}

async function seedArticle(slug: string, contentHash: string) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "seo_agent"."ArticleEmbedding" ("id", "slug", "url", "contentHash", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, now())`,
    slug,
    `https://miwebdeboda.com/blog/${slug}`,
    contentHash
  );
}

test("generateBriefing includes only Tier 2 open opportunities, with both articles' text for internal-link suggestions", async () => {
  await withEmptyOpportunities(async () => {
    await prisma.opportunity.create({
      data: {
        source: "internalLinking",
        findingType: "internal-link-suggestion",
        stableKey: `test-${Math.random()}`,
        sourceRefId: "ls-1",
        title: "Posible enlace interno: a → b",
        detail: { sourceSlug: "a", targetSlug: "b", similarity: 0.5 },
        impactScore: 4,
        confidenceScore: 1,
        effortScore: 2,
        priorityScore: 2,
        status: "open",
      },
    });
    // A Tier 1 opportunity should NOT appear in the Tier 2 briefing.
    await prisma.opportunity.create({
      data: {
        source: "robots",
        findingType: "robots-blocks-all",
        stableKey: `test-tier1-${Math.random()}`,
        sourceRefId: "row-1",
        title: "robots.txt bloquea todo el sitio",
        detail: {},
        impactScore: 10,
        confidenceScore: 1,
        effortScore: 1,
        priorityScore: 10,
        status: "open",
      },
    });

    const briefing = await generateBriefing({
      getArticleText: async ({ url }) => `contenido de ${url}`,
    });

    assert.ok(briefing.includes("Posible enlace interno"));
    assert.ok(briefing.includes("contenido de"));
    assert.ok(!briefing.includes("robots.txt bloquea todo el sitio"));
  });
});

test("generateBriefing reports a clean 'nothing to review' message when there are no open Tier 2 opportunities", async () => {
  await withEmptyOpportunities(async () => {
    const briefing = await generateBriefing({ getArticleText: async () => "" });

    assert.ok(briefing.toLowerCase().includes("no hay oportunidades"));
  });
});

test("generateBriefing skips a malformed internal-link-suggestion detail without aborting the whole briefing", async () => {
  await withEmptyOpportunities(async () => {
    await prisma.opportunity.create({
      data: {
        source: "internalLinking",
        findingType: "internal-link-suggestion",
        stableKey: `test-${Math.random()}`,
        sourceRefId: "ls-well-formed",
        title: "Posible enlace interno: c → d",
        detail: { sourceSlug: "c", targetSlug: "d", similarity: 0.7 },
        impactScore: 4,
        confidenceScore: 1,
        effortScore: 2,
        priorityScore: 3,
        status: "open",
      },
    });
    // Malformed detail: stored as JSON null (Json columns have no DB-level schema
    // enforcement, so a row can legitimately end up with detail === null at runtime).
    // Accessing detail.sourceSlug on null throws, which is exactly the crash this test guards against.
    await prisma.opportunity.create({
      data: {
        source: "internalLinking",
        findingType: "internal-link-suggestion",
        stableKey: `test-${Math.random()}`,
        sourceRefId: "ls-malformed",
        title: "Posible enlace interno: roto",
        detail: Prisma.JsonNull,
        impactScore: 4,
        confidenceScore: 1,
        effortScore: 2,
        priorityScore: 2.5,
        status: "open",
      },
    });

    const briefing = await generateBriefing({
      getArticleText: async ({ url }) => `contenido de ${url}`,
    });

    // The well-formed opportunity still gets its full section with fetched article text.
    assert.ok(briefing.includes("Posible enlace interno: c → d"));
    assert.ok(briefing.includes("contenido de"));

    // The malformed opportunity is flagged as skipped/malformed, not silently dropped or crashing.
    assert.ok(briefing.includes("Posible enlace interno: roto"));
    assert.ok(briefing.includes("ls-malformed"));
    assert.ok(/malformad|inválid|invalid|skip|omitid/i.test(briefing));
  });
});

test("generateBriefing omits an internal-link-suggestion already reviewed and rejected, as long as the source article hasn't changed since", async () => {
  await withEmptyArticleEmbeddings(() =>
    withEmptyOpportunities(async () => {
      await seedArticle("e", "hash-unchanged");

      await prisma.opportunity.create({
        data: {
          source: "internalLinking",
          findingType: "internal-link-suggestion",
          stableKey: `test-${Math.random()}`,
          sourceRefId: "ls-reviewed",
          title: "Posible enlace interno: e → f",
          detail: { sourceSlug: "e", targetSlug: "f", similarity: 0.6 },
          impactScore: 4,
          confidenceScore: 1,
          effortScore: 2,
          priorityScore: 2,
          status: "open",
          reviewedNoActionAt: new Date(),
          reviewedNoActionContentHash: "hash-unchanged",
          reviewedNoActionReason: "Sin frase natural donde encajar el enlace.",
        },
      });

      const briefing = await generateBriefing({ getArticleText: async () => "" });

      assert.ok(!briefing.includes("Posible enlace interno: e → f"));
    })
  );
});

test("generateBriefing re-includes a previously-rejected internal-link-suggestion once the source article's content has changed", async () => {
  await withEmptyArticleEmbeddings(() =>
    withEmptyOpportunities(async () => {
      await seedArticle("g", "hash-after-edit");

      await prisma.opportunity.create({
        data: {
          source: "internalLinking",
          findingType: "internal-link-suggestion",
          stableKey: `test-${Math.random()}`,
          sourceRefId: "ls-stale-review",
          title: "Posible enlace interno: g → h",
          detail: { sourceSlug: "g", targetSlug: "h", similarity: 0.6 },
          impactScore: 4,
          confidenceScore: 1,
          effortScore: 2,
          priorityScore: 2,
          status: "open",
          reviewedNoActionAt: new Date(),
          reviewedNoActionContentHash: "hash-before-edit",
          reviewedNoActionReason: "Sin frase natural donde encajar el enlace.",
        },
      });

      const briefing = await generateBriefing({
        getArticleText: async ({ url }) => `contenido de ${url}`,
      });

      assert.ok(briefing.includes("Posible enlace interno: g → h"));
    })
  );
});
