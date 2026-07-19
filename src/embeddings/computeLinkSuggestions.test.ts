import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { computeLinkSuggestions } from "./computeLinkSuggestions";

// ArticleEmbedding rows cost a real Cloudflare Workers AI API call to regenerate, and
// LinkSuggestion rows are real derived production data (140 rows as of the last audit).
// The "embedding" column is a Prisma Unsupported("vector") type, invisible to
// findMany/createMany, so ArticleEmbedding must be backed up/restored via raw SQL
// (casting vector <-> text) to avoid silently dropping the vector itself.
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

async function withEmptyLinkSuggestions<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.linkSuggestion.findMany({});
  await prisma.linkSuggestion.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.linkSuggestion.deleteMany({});
    if (backup.length > 0) {
      await prisma.linkSuggestion.createMany({ data: backup });
    }
  }
}

async function withEmptyTables<T>(fn: () => Promise<T>): Promise<T> {
  return withEmptyArticleEmbeddings(() => withEmptyLinkSuggestions(fn));
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

function makeVector(base: number[]): number[] {
  return [...base, ...new Array(1024 - base.length).fill(0)];
}

test("computeLinkSuggestions creates a suggestion for two highly similar articles", async () => {
  await withEmptyTables(async () => {
    await seedArticle("a", makeVector([1, 0, 0]));
    await seedArticle("b", makeVector([0.99, 0.01, 0]));

    const result = await computeLinkSuggestions();

    assert.equal(result.created > 0, true);
    const suggestions = await prisma.linkSuggestion.findMany({ where: { status: "open" } });
    assert.ok(suggestions.some((s) => s.sourceSlug === "a" && s.targetSlug === "b"));
  });
});

test("computeLinkSuggestions does not suggest a link between dissimilar articles", async () => {
  await withEmptyTables(async () => {
    await seedArticle("a", makeVector([1, 0, 0]));
    await seedArticle("c", makeVector([0, 1, 0]));

    await computeLinkSuggestions();

    const suggestions = await prisma.linkSuggestion.findMany({
      where: { sourceSlug: "a", targetSlug: "c" },
    });
    assert.equal(suggestions.length, 0);
  });
});

test("computeLinkSuggestions dismisses a previously-open suggestion that no longer meets the threshold", async () => {
  await withEmptyTables(async () => {
    await seedArticle("a", makeVector([1, 0, 0]));
    await seedArticle("b", makeVector([0.99, 0.01, 0]));
    await computeLinkSuggestions();

    // Article b's content changes enough that it's no longer similar to a.
    await prisma.$executeRawUnsafe(
      `UPDATE "seo_agent"."ArticleEmbedding" SET "embedding" = $1::vector WHERE "slug" = 'b'`,
      `[${makeVector([0, 1, 0]).join(",")}]`
    );

    const result = await computeLinkSuggestions();

    assert.equal(result.dismissed > 0, true);
    const suggestion = await prisma.linkSuggestion.findFirst({
      where: { sourceSlug: "a", targetSlug: "b" },
    });
    assert.equal(suggestion?.status, "dismissed");
  });
});
