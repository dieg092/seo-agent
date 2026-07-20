import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { prisma } from "../db";

const MIN_SIMILARITY = 0.35;
const TOP_N_PER_ARTICLE = 5;

// Category index pages (e.g. "organizar-boda") are rendered by
// src/app/blog/[categoria]/page.tsx directly from the list of articles in
// that category — there is no prose file where a Tier 2 reviewer could
// insert a natural inline link. Individual articles live at
// "<categoria>/<slug>", so a bare slug with no "/" is always a category
// page. Suggesting one as the SOURCE of a link is a dead-end opportunity
// that can never be resolved by the editorial workflow. A category page is
// still a perfectly valid link TARGET (e.g. "más ideas en la sección de
// inspiración"), so only the source side is filtered here.
function isIndividualArticle(slug: string): boolean {
  return slug.includes("/");
}

// Extracts the set of /blog/<slug> paths this article already links to, by
// looking at real <a href> tags in the live rendered page. Without this,
// applying a Tier 2 suggestion (or the link having existed all along) has no
// way to ever stop being re-proposed: the embedding similarity between two
// articles doesn't change just because one of them started linking to the
// other, so the same "fixed" suggestion would resurface on every run and
// undo its own resolution.
function extractLinkedSlugs(html: string): Set<string> {
  const $ = cheerio.load(html);
  const linked = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const match = href.match(/\/blog\/([^"?#\s]+)/);
    if (match) linked.add(match[1].replace(/\/$/, ""));
  });
  return linked;
}

function computeStableKey(sourceSlug: string, targetSlug: string): string {
  return createHash("sha256").update(`internalLinking:${sourceSlug}:${targetSlug}`).digest("hex");
}

interface SimilarPair {
  sourceSlug: string;
  targetSlug: string;
  similarity: number;
}

export async function computeLinkSuggestions(deps: {
  fetchHtml?: (url: string) => Promise<string>;
} = {}): Promise<{
  created: number;
  updated: number;
  dismissed: number;
}> {
  const fetchHtml =
    deps.fetchHtml ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status} (${url})`);
      return response.text();
    });

  const articles = await prisma.articleEmbedding.findMany({ select: { slug: true, url: true } });

  const currentPairs: SimilarPair[] = [];

  for (const article of articles) {
    if (!isIndividualArticle(article.slug)) continue;

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

    const candidates = rows.filter((row) => row.similarity >= MIN_SIMILARITY);
    if (candidates.length === 0) continue;

    // One fetch per source article covers every candidate target below,
    // rather than one fetch per pair.
    let alreadyLinked: Set<string>;
    try {
      const html = await fetchHtml(article.url);
      alreadyLinked = extractLinkedSlugs(html);
    } catch (error) {
      console.error(`No se pudo comprobar enlaces existentes en ${article.url} (se trata como sin enlaces):`, error);
      alreadyLinked = new Set();
    }

    for (const row of candidates) {
      if (alreadyLinked.has(row.targetSlug)) continue;
      currentPairs.push({ sourceSlug: article.slug, targetSlug: row.targetSlug, similarity: row.similarity });
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
