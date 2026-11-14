import type { Opportunity } from "@prisma/client";
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
  extractLowCtrFindings,
  extractNearPage1Findings,
  extractHighImpressionLowPositionFindings,
} from "./classify";
import { getHeuristic } from "./heuristics";
import { computeStableKey } from "./stableKey";
import { getCatalogEntry, isCritical } from "./catalog";
import { computePriority, dismissalValue, intentOfPage, pageOfFinding } from "./priority";
import {
  initialLifecycle,
  isOpportunityState,
  transition,
  type Lifecycle,
  type OpportunityState,
} from "../opportunity/lifecycle";
import type { Finding, FindingSource } from "./types";
import { computeAnnexBFindings } from "../detectors/loadAnnexB";

export const ALL_FINDING_SOURCES: FindingSource[] = [
  "sitemap",
  "robots",
  "structuredData",
  "performance",
  "internalLinking",
  "content",
  "siteArchitecture",
  "indexation",
  "privacy",
  "crawl",
  "visibility",
  "dataQuality",
  "funnel",
];

function aggregateClicksByPage(rows: { page: string; clicks: number }[]): { page: string; clicks: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.page, (totals.get(row.page) ?? 0) + row.clicks);
  }
  return Array.from(totals.entries()).map(([page, clicks]) => ({ page, clicks }));
}

// Agregado por página con posición media ponderada por impresiones, usado por
// los detectores de CTR/posición (Secciones A/B/C del brief).
function aggregatePageStats(
  rows: { page: string; clicks: number; impressions: number; position: number }[]
): { page: string; clicks: number; impressions: number; avgPosition: number }[] {
  const totals = new Map<string, { clicks: number; impressions: number; posWeighted: number }>();
  for (const row of rows) {
    const cur = totals.get(row.page) ?? { clicks: 0, impressions: 0, posWeighted: 0 };
    cur.clicks += row.clicks;
    cur.impressions += row.impressions;
    cur.posWeighted += row.position * row.impressions;
    totals.set(row.page, cur);
  }
  return Array.from(totals.entries()).map(([page, s]) => ({
    page,
    clicks: s.clicks,
    impressions: s.impressions,
    avgPosition: s.impressions > 0 ? s.posWeighted / s.impressions : 0,
  }));
}

/**
 * `annexB: false` deja solo los detectores de antes (lo usan los tests que
 * cuentan hallazgos exactos). Con el Anexo B, `visibility-declining`
 * sustituye a `content-declining`.
 */
export async function computeCurrentFindings(opts: { annexB?: boolean; now?: Date } = {}): Promise<Finding[]> {
  const annexB = opts.annexB ?? true;
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
    ...extractCannibalizationFindings(
      recentSnapshots.map((r) => ({ page: r.page, query: r.query, date: r.date, impressions: r.impressions })),
    )
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
  if (!annexB) findings.push(...extractDecliningFindings(recentByPage, priorByPage));

  findings.push(
    ...extractQueryGapFindings(
      recentSnapshots.map((r) => ({ page: r.page, query: r.query, impressions: r.impressions, clicks: r.clicks, position: r.position }))
    )
  );

  // Ventanas de 28 días (no 14, como el resto de este archivo) porque así lo
  // fija el brief para los umbrales de impresiones de las Secciones A/B/C.
  const recent28dSnapshots = await prisma.searchConsoleSnapshot.findMany({
    where: { date: { gte: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000) } },
  });
  const prior28dSnapshots = await prisma.searchConsoleSnapshot.findMany({
    where: {
      date: {
        gte: new Date(Date.now() - 56 * 24 * 60 * 60 * 1000),
        lt: new Date(Date.now() - 28 * 24 * 60 * 60 * 1000),
      },
    },
  });
  const recentPageStats = aggregatePageStats(recent28dSnapshots);
  const priorPageStats = aggregatePageStats(prior28dSnapshots);

  findings.push(...extractLowCtrFindings(recentPageStats));
  findings.push(...extractNearPage1Findings(recentPageStats, priorPageStats));
  findings.push(...extractHighImpressionLowPositionFindings(recentPageStats));

  if (annexB) findings.push(...(await computeAnnexBFindings(opts.now)));

  return findings;
}

type OpportunityRow = Opportunity;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Estados en los que una evaluación sin la condición puede cambiar algo (§6). */
const ABSENCE_STATES: OpportunityState[] = ["detected", "open", "verifying"];

export function lifecycleOf(row: OpportunityRow): Lifecycle {
  return {
    // Un valor desconocido (no debería haberlo) se trata como open, el estado de antes.
    state: isOpportunityState(row.state) ? row.state : "open",
    stateChangedAt: row.stateChangedAt,
    confirmations: row.confirmations,
    absences: row.absences,
    oscillations: row.oscillations,
    oscillationsSince: row.oscillationsSince,
    dismissedValue: row.dismissedValue,
    staleAt: row.staleAt,
  };
}

export function lifecycleData(lc: Lifecycle) {
  return {
    state: lc.state,
    stateChangedAt: lc.stateChangedAt,
    confirmations: lc.confirmations,
    absences: lc.absences,
    oscillations: lc.oscillations,
    oscillationsSince: lc.oscillationsSince,
    dismissedValue: lc.dismissedValue,
    staleAt: lc.staleAt,
  };
}

/**
 * Sincroniza los hallazgos con Opportunity. `status` (open/resolved) sigue la
 * regla de siempre (lo leen tier1, tier2 y el panel); `state` sigue el ciclo de
 * vida de §6, y cada hallazgo guarda su prioridad §12.2 con todos sus factores.
 */
export async function syncOpportunities(
  findings: Finding[],
  deps: { sourcesInScope?: FindingSource[]; now?: Date } = {}
): Promise<{ created: number; reopened: number; updated: number; resolved: number }> {
  const sourcesInScope = deps.sourcesInScope ?? ALL_FINDING_SOURCES;
  const now = deps.now ?? new Date();
  let created = 0;
  let reopened = 0;
  let updated = 0;
  let resolved = 0;

  const currentStableKeys = new Set<string>();

  for (const finding of findings) {
    const stableKey = computeStableKey(finding);
    // El mismo hallazgo dos veces en una evaluación cuenta como una sola confirmación.
    if (currentStableKeys.has(stableKey)) continue;
    currentStableKeys.add(stableKey);

    const heuristic = getHeuristic(finding.findingType);
    const entry = getCatalogEntry(finding.findingType);
    const page = pageOfFinding(finding);

    const existing = await prisma.opportunity.findUnique({ where: { stableKey } });

    const weeksOpen = existing ? Math.max(0, (now.getTime() - existing.firstDetectedAt.getTime()) / WEEK_MS) : 0;
    const { score: priorityScore, factors } = computePriority({
      severity: entry.severity,
      confidence: entry.confidence,
      autonomy: entry.autonomy,
      effort: heuristic.effortScore,
      intent: intentOfPage(page),
      // FunnelOrganicDaily aún no existe: value = 1 + intentW.
      funnel: null,
      indexationRisk: entry.indexationRisk,
      // learning solo se activa con volumen (§15.2, R-B5).
      learning: null,
      weeksOpen,
    });
    const confidenceScore = factors.confidenceW;

    const critical = isCritical(finding.findingType);
    let lifecycle = existing
      ? transition(lifecycleOf(existing), { type: "observed", critical, value: dismissalValue(factors) }, now)
      : initialLifecycle(critical, now);
    // Sin enlace a tareas (fase 3) solo puede caducar lo que está verificándose.
    lifecycle = transition(lifecycle, { type: "tick", taskClosed: false }, now);

    const shared = {
      sourceRefId: finding.sourceRefId,
      title: finding.title,
      detail: finding.detail as object,
      confidenceScore,
      priorityScore,
      page,
      operation: entry.operation,
      autonomy: entry.autonomy,
      lane: entry.lane,
      severity: entry.severity,
      confidence: entry.confidence,
      businessValue: factors.value,
      priorityFactors: { ...factors } as object,
      ...lifecycleData(lifecycle),
    };

    if (!existing) {
      await prisma.opportunity.create({
        data: {
          source: finding.source,
          findingType: finding.findingType,
          stableKey,
          impactScore: heuristic.impactScore,
          effortScore: heuristic.effortScore,
          status: "open",
          ...shared,
        },
      });
      created += 1;
    } else if (existing.status === "resolved") {
      await prisma.opportunity.update({
        where: { stableKey },
        data: { status: "open", resolvedAt: null, ...shared },
      });
      reopened += 1;
    } else {
      await prisma.opportunity.update({ where: { stableKey }, data: shared });
      updated += 1;
    }
  }

  const absentCandidates = await prisma.opportunity.findMany({
    where: { OR: [{ status: "open" }, { state: { in: ABSENCE_STATES } }] },
  });
  for (const opportunity of absentCandidates) {
    if (!sourcesInScope.includes(opportunity.source as FindingSource)) continue;
    if (currentStableKeys.has(opportunity.stableKey)) continue;

    const lifecycle = transition(lifecycleOf(opportunity), { type: "absent" }, now);
    const wasOpen = opportunity.status === "open";
    await prisma.opportunity.update({
      where: { id: opportunity.id },
      data: {
        ...lifecycleData(lifecycle),
        ...(wasOpen ? { status: "resolved", resolvedAt: now } : {}),
      },
    });
    if (wasOpen) resolved += 1;
  }

  return { created, reopened, updated, resolved };
}
