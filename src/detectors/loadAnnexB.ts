// src/detectors/loadAnnexB.ts
// Carga de datos de los detectores del Anexo B (annexB.ts). Solo lectura.
import { prisma } from "../db";
import type { Finding } from "../prioritization/types";
import {
  extractCollectorFindings,
  extractCrawlFindings,
  extractDataQualityFindings,
  extractFunnelFindings,
  extractGscSitemapFindings,
  extractIndexBloatFindings,
  extractIndexationFindings,
  extractPrivacyFindings,
  extractSegmentFindings,
  extractVisibilityFindings,
} from "./annexB";
import { extractStrategyFindings } from "../strategy/keywords";
import { extractCompetitorGaps } from "../competitors/gaps";
import { extractEditorialFindings, extractPrepublishFindings, type LatestScore, type PrepublishScore } from "../editorial/findings";
import { extractIntentMismatchFindings, extractSeasonalFindings, SEASONAL_WINDOW_DAYS } from "../strategy/intentSignals";

const DAY_MS = 24 * 60 * 60 * 1000;
/** GSC tarda unos 3 días en cerrar un día (§15.2). */
const GSC_LAG_DAYS = 3;

function sumByPage(rows: { page: string; impressions: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.page, (out.get(r.page) ?? 0) + r.impressions);
  return out;
}

export async function computeAnnexBFindings(now: Date = new Date()): Promise<Finding[]> {
  const findings: Finding[] = [];
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

  // Ventanas de 28 días que acaban en el último día cerrado.
  const recentEnd = ago(GSC_LAG_DAYS);
  const recentStart = ago(GSC_LAG_DAYS + 28);
  const priorStart = ago(GSC_LAG_DAYS + 56);

  const pageRows = await prisma.searchConsolePageDaily.findMany({
    where: { date: { gte: ago(GSC_LAG_DAYS + 90), lt: recentEnd } },
    select: { date: true, page: true, type: true, clicks: true, impressions: true },
  });
  const inRange = (from: Date, to: Date) => pageRows.filter((r) => r.date >= from && r.date < to);
  const recentPages = inRange(recentStart, recentEnd);
  const priorPages = inRange(priorStart, recentStart);
  const webImpr28d = sumByPage(recentPages.filter((r) => r.type === "web"));
  const webImpr90d = sumByPage(pageRows.filter((r) => r.type === "web"));

  const inspections = await prisma.urlInspection.findMany({ where: { inspectedAt: { gte: ago(60) } } });
  findings.push(...extractIndexationFindings(inspections, webImpr28d, now));

  const sitemapStatus = await prisma.gscSitemapStatus.findMany({
    where: { checkedAt: { gte: ago(30) } },
    select: { id: true, path: true, checkedAt: true, lastDownloaded: true, isPending: true, errors: true },
  });
  findings.push(...extractGscSitemapFindings(sitemapStatus, now));

  const incidents = await prisma.privateIncident.findMany({
    where: { resolvedAt: null },
    select: { id: true, urlHmac: true, sources: true, resolvedAt: true },
  });
  findings.push(...extractPrivacyFindings(incidents));

  const latestCrawl = await prisma.crawlPage.findFirst({ orderBy: { runAt: "desc" }, select: { runAt: true } });
  if (latestCrawl && latestCrawl.runAt >= ago(14)) {
    const crawl = await prisma.crawlPage.findMany({ where: { runAt: latestCrawl.runAt } });
    findings.push(...extractCrawlFindings(crawl));
    findings.push(
      ...extractIndexBloatFindings(
        crawl.filter((r) => r.inSitemap).map((r) => r.url),
        webImpr90d,
      ),
    );
  }

  findings.push(...extractVisibilityFindings(recentPages, priorPages));

  const segments = await prisma.searchConsoleSegmentDaily.findMany({
    where: { date: { gte: priorStart, lt: recentEnd }, type: "web" },
    select: { date: true, page: true, device: true, country: true, impressions: true },
  });
  findings.push(
    ...extractSegmentFindings(
      segments.filter((r) => r.date >= recentStart),
      segments.filter((r) => r.date < recentStart),
    ),
  );

  const quality = await prisma.gscDataQuality.findMany({ where: { date: { gte: ago(21) } } });
  findings.push(...extractDataQualityFindings(quality, now));

  const heartbeats = await prisma.workflowHeartbeat.findMany({
    select: { id: true, workflowName: true, lastRunAt: true, lastStatus: true },
  });
  findings.push(...extractCollectorFindings(heartbeats, now));

  const funnel = await prisma.funnelOrganicDaily.findMany({
    where: { date: { gte: ago(125) } },
    select: { date: true, channel: true, registros: true, bodasPublicadas: true, pagos: true },
  });
  findings.push(...extractFunnelFindings(funnel, now));

  // Fase 5: clústeres de la última reconstrucción mensual (scripts/build-keywords.ts).
  const clusters = await prisma.topicCluster.findMany({});
  if (clusters.length > 0) {
    const kws = await prisma.keywordCandidate.findMany({ select: { query: true, clusterId: true, impressions90d: true } });
    const queriesOf = new Map<string, string[]>();
    for (const k of [...kws].sort((a, b) => b.impressions90d - a.impressions90d)) {
      if (k.clusterId) queriesOf.set(k.clusterId, [...(queriesOf.get(k.clusterId) ?? []), k.query]);
    }
    findings.push(
      ...extractStrategyFindings(
        clusters.map((c) => ({ ...c, intent: c.intent as "transactional", queries: queriesOf.get(c.id) ?? [] })),
      ),
    );
  }

  // Fase 5 (§16.3): temas de competidores sin cubrir. Lo nuestro: consultas de GSC y artículos.
  const competitorPages = await prisma.competitorPage.findMany({
    where: { fetchedAt: { gte: ago(180) }, status: 200 },
    select: { domain: true, url: true, path: true, title: true, h1: true, embedding: true },
  });
  if (competitorPages.some((p) => p.embedding.length > 0)) {
    const ours = (await prisma.keywordCandidate.findMany({ select: { embedding: true } })).map((k) => k.embedding).filter((e) => e.length > 0);
    const articles = await prisma.$queryRaw<{ v: string }[]>`SELECT embedding::text AS v FROM "seo_agent"."ArticleEmbedding" WHERE embedding IS NOT NULL`;
    for (const a of articles) {
      try {
        ours.push(JSON.parse(a.v) as number[]);
      } catch {
        // vector ilegible: se ignora
      }
    }
    // Sin nada nuestro con que comparar, todo saldría como hueco: mejor no decir nada.
    if (ours.length > 0) findings.push(...extractCompetitorGaps(competitorPages, ours));
  }

  // Fase 5 (§16.2): intención que no encaja (GSC + GA4 de 90 días) y estacionalidad propia.
  const pages90 = await prisma.$queryRaw<{ page: string; impressions: number; clicks: number; position: number }[]>`
    SELECT page, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks,
           (sum(coalesce(position, 0) * impressions) / nullif(sum(impressions), 0))::float AS position
    FROM "seo_agent"."SearchConsolePageDaily" WHERE type = 'web' AND date >= ${ago(90)} GROUP BY page`;
  const ga90 = await prisma.$queryRaw<{ page: string; sessions: number; engaged: number }[]>`
    SELECT "landingPage" AS page, sum(sessions)::int AS sessions, sum("engagedSessions")::int AS engaged
    FROM "seo_agent"."AnalyticsLandingDaily" WHERE channel = 'Organic Search' AND date >= ${ago(90)} GROUP BY "landingPage"`;
  const gaBy = new Map(ga90.map((g) => [g.page, g]));
  findings.push(
    ...extractIntentMismatchFindings(
      pages90.map((p) => ({ ...p, position: p.position ?? 0, sessions: gaBy.get(p.page)?.sessions ?? 0, engagedSessions: gaBy.get(p.page)?.engaged ?? 0 })),
    ),
  );
  const earliest = (await prisma.searchConsoleSnapshot.aggregate({ _min: { date: true } }))._min.date;
  if (earliest && now.getTime() - earliest.getTime() >= 395 * 86400_000) {
    const from = new Date(now.getTime() - (730 - SEASONAL_WINDOW_DAYS) * 86400_000);
    const to = new Date(now.getTime() - (365 - SEASONAL_WINDOW_DAYS) * 86400_000);
    const rows = await prisma.$queryRaw<{ date: Date; query: string; page: string; impressions: number }[]>`
      SELECT date, query, page, impressions FROM "seo_agent"."SearchConsoleSnapshot" WHERE date >= ${from} AND date < ${to} AND impressions > 0`;
    findings.push(...extractSeasonalFindings(rows, earliest, now));
  }

  // Fase 5 (§16.4): artículos que la IA editorial bloquea, solo con la calibración en verde.
  const calibration = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  if (calibration?.status === "ok") {
    const latest = await prisma.editorialScore.findMany({
      where: { kind: { in: ["routine", "calibration"] } },
      orderBy: { createdAt: "desc" },
      distinct: ["slug"],
      select: { slug: true, url: true, contentHash: true, finalScore: true, decision: true, reason: true, criteria: true },
    });
    findings.push(...extractEditorialFindings(latest as unknown as LatestScore[]));
    const prepublish = await prisma.editorialScore.findMany({
      where: { kind: "prepublish" },
      orderBy: { createdAt: "desc" },
      distinct: ["slug"],
      select: { slug: true, url: true, contentHash: true, finalScore: true, decision: true, reason: true, criteria: true, deterministic: true },
    });
    findings.push(...extractPrepublishFindings(prepublish as unknown as PrepublishScore[], now));
  }

  return findings;
}
