// src/embeddings/generateEmbeddings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { generateEmbeddings } from "./generateEmbeddings";

// ArticleEmbedding rows cost a real Cloudflare Workers AI API call to regenerate. Its
// "embedding" column is a Prisma Unsupported("vector") type, so it is invisible to
// findMany/createMany — a naive Prisma-only backup would silently drop the actual vector
// data on restore. Back up and restore via raw SQL (casting vector <-> text) so the
// embedding itself survives, not just the row shell.
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
    for (const row of backup) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "seo_agent"."ArticleEmbedding" ("id", "slug", "url", "contentHash", "embedding", "updatedAt") VALUES ($1, $2, $3, $4, $5::vector, $6)`,
        row.id,
        row.slug,
        row.url,
        row.contentHash,
        row.embedding,
        row.updatedAt
      );
    }
  }
}

test("generateEmbeddings embeds a new article and stores its content hash", async () => {
  await withEmptyArticleEmbeddings(async () => {
    const result = await generateEmbeddings({
      getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
      getText: async () => "contenido del artículo a",
      embed: async () => new Array(1024).fill(0.1),
    });

    assert.equal(result.embedded, 1);
    assert.equal(result.skippedUnchanged, 0);

    const stored = await prisma.articleEmbedding.findUnique({ where: { slug: "a" } });
    assert.ok(stored);
    assert.equal(stored?.contentHash.length > 0, true);
  });
});

test("generateEmbeddings skips re-embedding when the content hash is unchanged", async () => {
  await withEmptyArticleEmbeddings(async () => {
    const deps = {
      getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
      getText: async () => "contenido sin cambios",
      embed: async () => new Array(1024).fill(0.2),
    };

    const first = await generateEmbeddings(deps);
    assert.equal(first.embedded, 1);

    let embedCallCount = 0;
    const second = await generateEmbeddings({
      ...deps,
      embed: async () => {
        embedCallCount += 1;
        return new Array(1024).fill(0.2);
      },
    });

    assert.equal(second.embedded, 0);
    assert.equal(second.skippedUnchanged, 1);
    assert.equal(embedCallCount, 0);
  });
});

test("generateEmbeddings re-embeds when the article's text actually changed", async () => {
  await withEmptyArticleEmbeddings(async () => {
    await generateEmbeddings({
      getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
      getText: async () => "versión original",
      embed: async () => new Array(1024).fill(0.1),
    });

    const result = await generateEmbeddings({
      getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
      getText: async () => "versión actualizada, texto distinto",
      embed: async () => new Array(1024).fill(0.3),
    });

    assert.equal(result.embedded, 1);
    assert.equal(result.skippedUnchanged, 0);
  });
});
