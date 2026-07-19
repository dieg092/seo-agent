// src/siteArchitecture/queries.ts
import { prisma } from "../db";
import { getEnv } from "../env";
import { getPublishedArticleUrls } from "../embeddings/fetchArticleContent";
import { SPANISH_PROVINCES } from "./spanishProvinces";

const DEFAULT_MIN_RUNS = 3;

export async function getTemplatePerformanceHistory(
  deps: { minRuns?: number } = {}
): Promise<{ url: string; scores: number[] }[]> {
  const minRuns = deps.minRuns ?? DEFAULT_MIN_RUNS;

  const rows = await prisma.performanceAuditResult.findMany({
    where: { performanceScore: { not: null } },
    select: { url: true, performanceScore: true },
  });

  const scoresByUrl = new Map<string, number[]>();
  for (const row of rows) {
    if (row.performanceScore === null) continue;
    if (!scoresByUrl.has(row.url)) scoresByUrl.set(row.url, []);
    scoresByUrl.get(row.url)!.push(row.performanceScore);
  }

  const result: { url: string; scores: number[] }[] = [];
  for (const [url, scores] of scoresByUrl) {
    if (scores.length >= minRuns) {
      result.push({ url, scores });
    }
  }
  return result;
}

const NEAR_DUPLICATE_THRESHOLD = 0.92;

export async function getNearDuplicatePairs(): Promise<{ slugA: string; slugB: string; similarity: number }[]> {
  const rows = await prisma.$queryRawUnsafe<{ slugA: string; slugB: string; similarity: number }[]>(
    `
    SELECT a."slug" AS "slugA", b."slug" AS "slugB", 1 - (a."embedding" <=> b."embedding") AS similarity
    FROM "seo_agent"."ArticleEmbedding" a
    JOIN "seo_agent"."ArticleEmbedding" b ON a."slug" < b."slug"
    WHERE 1 - (a."embedding" <=> b."embedding") >= $1
    ORDER BY similarity DESC
    `,
    NEAR_DUPLICATE_THRESHOLD
  );
  return rows;
}

const MIN_PROVINCE_IMPRESSIONS = 500;
const HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export async function getMissingProvincialTemplateCandidates(
  deps: { fetchXml?: (url: string) => Promise<string> } = {}
): Promise<{ province: string; impressions: number }[]> {
  const baseUrl = getEnv("SITE_BASE_URL");
  const since = new Date(Date.now() - HISTORY_WINDOW_MS);

  const snapshots = await prisma.searchConsoleSnapshot.findMany({
    where: { date: { gte: since } },
    select: { query: true, impressions: true },
  });

  const impressionsByProvince = new Map<string, number>();
  for (const province of SPANISH_PROVINCES) {
    let total = 0;
    for (const snap of snapshots) {
      if (snap.query.toLowerCase().includes(province)) total += snap.impressions;
    }
    if (total > 0) impressionsByProvince.set(province, total);
  }

  const publishedUrls = await getPublishedArticleUrls({ fetchXml: deps.fetchXml, baseUrl });
  const existingProvinceSlugs = new Set(
    publishedUrls
      .map((u) => u.slug.toLowerCase())
      .filter((slug) => SPANISH_PROVINCES.some((p) => slug.includes(p)))
  );

  const candidates: { province: string; impressions: number }[] = [];
  for (const [province, impressions] of impressionsByProvince) {
    const hasExisting = Array.from(existingProvinceSlugs).some((slug) => slug.includes(province));
    if (impressions >= MIN_PROVINCE_IMPRESSIONS && !hasExisting) {
      candidates.push({ province, impressions });
    }
  }
  return candidates;
}
