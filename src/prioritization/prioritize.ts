import { prisma } from "../db";
import {
  extractSitemapFindings,
  extractRobotsFindings,
  extractStructuredDataFindings,
  extractPerformanceFindings,
  extractInternalLinkFindings,
  extractCannibalizationFindings,
  extractDecliningFindings,
  extractQueryGapFindings,
} from "./classify";
import { getHeuristic } from "./heuristics";
import { computeStableKey } from "./stableKey";
import type { Finding, FindingSource } from "./types";

export const ALL_FINDING_SOURCES: FindingSource[] = [
  "sitemap",
  "robots",
  "structuredData",
  "performance",
  "internalLinking",
  "content",
  "siteArchitecture",
];

function aggregateClicksByPage(rows: { page: string; clicks: number }[]): { page: string; clicks: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.page, (totals.get(row.page) ?? 0) + row.clicks);
  }
  return Array.from(totals.entries()).map(([page, clicks]) => ({ page, clicks }));
}

export async function computeCurrentFindings(): Promise<Finding[]> {
  const findings: Finding[] = [];

  const latestSitemap = await prisma.sitemapAuditResult.findFirst({ orderBy: { runAt: "desc" } });
  if (latestSitemap) {
    findings.push(...extractSitemapFindings(latestSitemap));
  }

  const latestRobots = await prisma.robotsAuditResult.findFirst({ orderBy: { runAt: "desc" } });
  if (latestRobots) {
    findings.push(...extractRobotsFindings(latestRobots));
  }

  const latestStructuredDataRun = await prisma.structuredDataAuditResult.findFirst({
    orderBy: { runAt: "desc" },
  });
  if (latestStructuredDataRun) {
    const batch = await prisma.structuredDataAuditResult.findMany({
      where: { runAt: latestStructuredDataRun.runAt },
    });
    findings.push(...extractStructuredDataFindings(batch));
  }

  const latestPerformanceRun = await prisma.performanceAuditResult.findFirst({
    orderBy: { runAt: "desc" },
  });
  if (latestPerformanceRun) {
    const batch = await prisma.performanceAuditResult.findMany({
      where: { runAt: latestPerformanceRun.runAt },
    });
    findings.push(...extractPerformanceFindings(batch));
  }

  const openLinkSuggestions = await prisma.linkSuggestion.findMany({ where: { status: "open" } });
  findings.push(...extractInternalLinkFindings(openLinkSuggestions));

  const recentSnapshots = await prisma.searchConsoleSnapshot.findMany({
    where: { date: { gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } },
  });
  findings.push(
    ...extractCannibalizationFindings(recentSnapshots.map((r) => ({ page: r.page, query: r.query, date: r.date })))
  );

  const priorSnapshots = await prisma.searchConsoleSnapshot.findMany({
    where: {
      date: {
        gte: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000),
        lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
      },
    },
  });
  const recentByPage = aggregateClicksByPage(recentSnapshots);
  const priorByPage = aggregateClicksByPage(priorSnapshots);
  findings.push(...extractDecliningFindings(recentByPage, priorByPage));

  findings.push(
    ...extractQueryGapFindings(
      recentSnapshots.map((r) => ({ page: r.page, query: r.query, impressions: r.impressions, clicks: r.clicks, position: r.position }))
    )
  );

  return findings;
}

export async function syncOpportunities(
  findings: Finding[],
  deps: { sourcesInScope?: FindingSource[] } = {}
): Promise<{ created: number; reopened: number; updated: number; resolved: number }> {
  const sourcesInScope = deps.sourcesInScope ?? ALL_FINDING_SOURCES;
  let created = 0;
  let reopened = 0;
  let updated = 0;
  let resolved = 0;

  const currentStableKeys = new Set<string>();

  for (const finding of findings) {
    const stableKey = computeStableKey(finding);
    currentStableKeys.add(stableKey);

    const heuristic = getHeuristic(finding.findingType);
    const confidenceScore = 1.0;
    const priorityScore = (heuristic.impactScore * confidenceScore) / heuristic.effortScore;

    const existing = await prisma.opportunity.findUnique({ where: { stableKey } });

    if (!existing) {
      await prisma.opportunity.create({
        data: {
          source: finding.source,
          findingType: finding.findingType,
          stableKey,
          sourceRefId: finding.sourceRefId,
          title: finding.title,
          detail: finding.detail as object,
          impactScore: heuristic.impactScore,
          confidenceScore,
          effortScore: heuristic.effortScore,
          priorityScore,
          status: "open",
        },
      });
      created += 1;
    } else if (existing.status === "resolved") {
      await prisma.opportunity.update({
        where: { stableKey },
        data: {
          status: "open",
          resolvedAt: null,
          sourceRefId: finding.sourceRefId,
          title: finding.title,
          detail: finding.detail as object,
          priorityScore,
        },
      });
      reopened += 1;
    } else {
      await prisma.opportunity.update({
        where: { stableKey },
        data: {
          sourceRefId: finding.sourceRefId,
          title: finding.title,
          detail: finding.detail as object,
          priorityScore,
        },
      });
      updated += 1;
    }
  }

  const openOpportunities = await prisma.opportunity.findMany({ where: { status: "open" } });
  for (const opportunity of openOpportunities) {
    if (!sourcesInScope.includes(opportunity.source as FindingSource)) continue;
    if (!currentStableKeys.has(opportunity.stableKey)) {
      await prisma.opportunity.update({
        where: { id: opportunity.id },
        data: { status: "resolved", resolvedAt: new Date() },
      });
      resolved += 1;
    }
  }

  return { created, reopened, updated, resolved };
}
