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

  return findings;
}
