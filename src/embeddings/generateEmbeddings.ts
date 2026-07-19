// src/embeddings/generateEmbeddings.ts
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { getPublishedArticleUrls, fetchArticleText } from "./fetchArticleContent";
import { embedText } from "../embeddings/cloudflareEmbeddings";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function generateEmbeddings(deps: {
  getUrls?: typeof getPublishedArticleUrls;
  getText?: typeof fetchArticleText;
  embed?: typeof embedText;
} = {}): Promise<{ embedded: number; skippedUnchanged: number }> {
  const getUrls = deps.getUrls ?? getPublishedArticleUrls;
  const getText = deps.getText ?? fetchArticleText;
  const embed = deps.embed ?? embedText;

  const articles = await getUrls();

  let embedded = 0;
  let skippedUnchanged = 0;

  for (const article of articles) {
    const text = await getText({ url: article.url });
    const contentHash = hashText(text);

    const existing = await prisma.articleEmbedding.findUnique({ where: { slug: article.slug } });
    if (existing && existing.contentHash === contentHash) {
      skippedUnchanged += 1;
      continue;
    }

    const vector = await embed(text);
    const vectorLiteral = toVectorLiteral(vector);

    if (existing) {
      await prisma.$executeRawUnsafe(
        `UPDATE "seo_agent"."ArticleEmbedding" SET "contentHash" = $1, "embedding" = $2::vector, "updatedAt" = now() WHERE "slug" = $3`,
        contentHash,
        vectorLiteral,
        article.slug
      );
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "seo_agent"."ArticleEmbedding" ("id", "slug", "url", "contentHash", "embedding", "updatedAt") VALUES (gen_random_uuid(), $1, $2, $3, $4::vector, now())`,
        article.slug,
        article.url,
        contentHash,
        vectorLiteral
      );
    }

    embedded += 1;
  }

  return { embedded, skippedUnchanged };
}
