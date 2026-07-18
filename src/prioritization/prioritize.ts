import { prisma } from "../db";
import {
  extractSitemapFindings,
  extractRobotsFindings,
  extractStructuredDataFindings,
  extractPerformanceFindings,
} from "./classify";
import { getHeuristic } from "./heuristics";
import { computeStableKey } from "./stableKey";
import type { Finding } from "./types";

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

  return findings;
}

export async function syncOpportunities(
  findings: Finding[]
): Promise<{ created: number; reopened: number; updated: number; resolved: number }> {
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
