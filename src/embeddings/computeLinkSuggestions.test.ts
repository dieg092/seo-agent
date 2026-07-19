import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { computeLinkSuggestions } from "./computeLinkSuggestions";

async function resetTables() {
  await prisma.linkSuggestion.deleteMany({});
  await prisma.articleEmbedding.deleteMany({});
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
  await resetTables();

  await seedArticle("a", makeVector([1, 0, 0]));
  await seedArticle("b", makeVector([0.99, 0.01, 0]));

  const result = await computeLinkSuggestions();

  assert.equal(result.created > 0, true);
  const suggestions = await prisma.linkSuggestion.findMany({ where: { status: "open" } });
  assert.ok(suggestions.some((s) => s.sourceSlug === "a" && s.targetSlug === "b"));

  await resetTables();
});

test("computeLinkSuggestions does not suggest a link between dissimilar articles", async () => {
  await resetTables();

  await seedArticle("a", makeVector([1, 0, 0]));
  await seedArticle("c", makeVector([0, 1, 0]));

  await computeLinkSuggestions();

  const suggestions = await prisma.linkSuggestion.findMany({
    where: { sourceSlug: "a", targetSlug: "c" },
  });
  assert.equal(suggestions.length, 0);

  await resetTables();
});

test("computeLinkSuggestions dismisses a previously-open suggestion that no longer meets the threshold", async () => {
  await resetTables();

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

  await resetTables();
});
