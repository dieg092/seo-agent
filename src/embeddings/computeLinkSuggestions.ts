import { createHash } from "node:crypto";
import { prisma } from "../db";

const MIN_SIMILARITY = 0.35;
const TOP_N_PER_ARTICLE = 5;

function computeStableKey(sourceSlug: string, targetSlug: string): string {
  return createHash("sha256").update(`internalLinking:${sourceSlug}:${targetSlug}`).digest("hex");
}

interface SimilarPair {
  sourceSlug: string;
  targetSlug: string;
  similarity: number;
}

export async function computeLinkSuggestions(): Promise<{
  created: number;
  updated: number;
  dismissed: number;
}> {
  const articles = await prisma.articleEmbedding.findMany({ select: { slug: true } });

  const currentPairs: SimilarPair[] = [];

  for (const article of articles) {
    const rows = await prisma.$queryRawUnsafe<{ targetSlug: string; similarity: number }[]>(
      `
      SELECT b."slug" AS "targetSlug", 1 - (a."embedding" <=> b."embedding") AS similarity
      FROM "seo_agent"."ArticleEmbedding" a, "seo_agent"."ArticleEmbedding" b
      WHERE a."slug" = $1 AND b."slug" != $1
      ORDER BY a."embedding" <=> b."embedding" ASC
      LIMIT $2
      `,
      article.slug,
      TOP_N_PER_ARTICLE
    );

    for (const row of rows) {
      if (row.similarity >= MIN_SIMILARITY) {
        currentPairs.push({ sourceSlug: article.slug, targetSlug: row.targetSlug, similarity: row.similarity });
      }
    }
  }

  let created = 0;
  let updated = 0;
  let dismissed = 0;

  const currentStableKeys = new Set<string>();

  for (const pair of currentPairs) {
    const stableKey = computeStableKey(pair.sourceSlug, pair.targetSlug);
    currentStableKeys.add(stableKey);

    const existing = await prisma.linkSuggestion.findUnique({ where: { stableKey } });

    if (!existing) {
      await prisma.linkSuggestion.create({
        data: {
          sourceSlug: pair.sourceSlug,
          targetSlug: pair.targetSlug,
          similarity: pair.similarity,
          stableKey,
          status: "open",
        },
      });
      created += 1;
    } else {
      await prisma.linkSuggestion.update({
        where: { stableKey },
        data: { similarity: pair.similarity, status: existing.status === "dismissed" ? "open" : existing.status },
      });
      updated += 1;
    }
  }

  const openSuggestions = await prisma.linkSuggestion.findMany({ where: { status: "open" } });
  for (const suggestion of openSuggestions) {
    if (!currentStableKeys.has(suggestion.stableKey)) {
      await prisma.linkSuggestion.update({
        where: { id: suggestion.id },
        data: { status: "dismissed" },
      });
      dismissed += 1;
    }
  }

  return { created, updated, dismissed };
}
