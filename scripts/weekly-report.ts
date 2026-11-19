// scripts/weekly-report.ts
// Informe semanal (§20). Lee seo_agent, escribe weekly-report.md (artefacto del
// workflow) y manda el resumen por Telegram. Solo lectura en la BD.
import { writeFileSync } from "node:fs";
import { prisma } from "../src/db";
import { buildTelegramSummary, buildWeeklyReport, type FunnelWeek, type ReportInput } from "../src/report/weeklyReport";
import { latestInspections } from "../src/detectors/annexB";
import { ORGANIC_CHANNELS } from "../src/detectors/annexB";
import { isPrivateUrl } from "../src/privacy/sitePrivacy";
import { sendTelegramMessage } from "../src/alerts/sendTelegramMessage";

const DAY_MS = 24 * 60 * 60 * 1000;
const GSC_LAG_DAYS = 3;
const AI_CHANNEL = "AI Assistant";

/** Ruta de una página de entrada pública del sitio; null si es privada, ajena o ilegible. */
function publicLandingPath(page: string): string | null {
  if (page.includes("<privada:")) return null;
  try {
    const u = new URL(page, "https://miwebdeboda.com");
    if (!/(^|\.)miwebdeboda\.com$/.test(u.hostname) || isPrivateUrl(u.href)) return null;
    return u.pathname;
  } catch {
    return null;
  }
}

async function funnelWeek(from: Date, to: Date): Promise<FunnelWeek> {
  const gsc = await prisma.searchConsolePageDaily.aggregate({
    where: { date: { gte: from, lt: to }, type: "web" },
    _sum: { clicks: true },
  });
  const app = await prisma.funnelOrganicDaily.aggregate({
    where: { date: { gte: from, lt: to }, channel: { in: [...ORGANIC_CHANNELS] } },
    _sum: { registros: true, bodasPublicadas: true, pagos: true, revenueCents: true },
  });
  return {
    clicks: gsc._sum.clicks ?? 0,
    registros: app._sum.registros ?? 0,
    bodasPublicadas: app._sum.bodasPublicadas ?? 0,
    pagos: app._sum.pagos ?? 0,
    revenueCents: app._sum.revenueCents ?? 0,
  };
}

export async function loadReportInput(now: Date = new Date()): Promise<ReportInput> {
  const ago = (d: number) => new Date(now.getTime() - d * DAY_MS);
  const end = ago(GSC_LAG_DAYS);

  const inspections = await prisma.urlInspection.findMany({ where: { inspectedAt: { gte: ago(60) } } });
  const latest = [...latestInspections(inspections).values()].map((l) => l[0]);
  const inSitemap = latest.filter((r) => r.inSitemap);

  const open = await prisma.opportunity.findMany({
    where: { status: "open" },
    orderBy: { priorityScore: "desc" },
    take: 10,
    select: { title: true, priorityScore: true, lane: true, autonomy: true, severity: true },
  });
  const states = await prisma.opportunity.groupBy({ by: ["state"], _count: { _all: true } });
  const lanes = await prisma.opportunity.groupBy({ by: ["lane"], where: { status: "open" }, _count: { _all: true } });
  const stale = await prisma.opportunity.findMany({ where: { state: "stale" }, select: { title: true }, take: 20 });
  const measurements = await prisma.impactMeasurement.groupBy({ by: ["outcome"], _count: { _all: true } });
  const heartbeats = await prisma.workflowHeartbeat.findMany({ select: { workflowName: true, lastStatus: true, lastRunAt: true } });
  const discover = await prisma.searchConsolePageDaily.aggregate({
    where: { date: { gte: ago(GSC_LAG_DAYS + 28), lt: end }, type: "discover" },
    _sum: { impressions: true },
  });

  // Bing agrega por semana: se cogen las semanas que empiezan en cada ventana.
  const bingSum = (from: Date, to: Date) =>
    prisma.bingQueryStat.aggregate({ where: { date: { gte: from, lt: to } }, _sum: { clicks: true, impressions: true } });
  const [bingLast, bingPrior] = await Promise.all([bingSum(ago(28), now), bingSum(ago(56), ago(28))]);
  const bingTop = await prisma.bingQueryStat.groupBy({
    by: ["query"],
    where: { date: { gte: ago(28) }, isBrand: false, NOT: { query: { contains: "<privada:" } } },
    _sum: { impressions: true, clicks: true },
    orderBy: { _sum: { impressions: "desc" } },
    take: 5,
  });
  const hasBing = (await prisma.bingQueryStat.count()) > 0;

  // Asistentes de IA (GA4). Las páginas de entrada privadas no salen nunca.
  const aiSum = (from: Date, to: Date) =>
    prisma.analyticsLandingDaily.aggregate({ where: { channel: AI_CHANNEL, date: { gte: from, lt: to } }, _sum: { sessions: true, keyEvents: true } });
  const [aiLast, aiPrior] = await Promise.all([aiSum(ago(28), now), aiSum(ago(56), ago(28))]);
  const aiTop = (
    await prisma.analyticsLandingDaily.groupBy({
      by: ["landingPage"],
      where: { channel: AI_CHANNEL, date: { gte: ago(28) } },
      _sum: { sessions: true },
      orderBy: { _sum: { sessions: "desc" } },
      take: 20,
    })
  )
    .map((r) => ({ path: publicLandingPath(r.landingPage), sessions: r._sum.sessions ?? 0 }))
    .filter((r): r is { path: string; sessions: number } => r.path !== null)
    .slice(0, 5);
  const hasAi = (await prisma.analyticsLandingDaily.count({ where: { channel: AI_CHANNEL } })) > 0;

  return {
    generatedAt: now,
    bing: hasBing
      ? {
          clicks28: bingLast._sum.clicks ?? 0,
          impressions28: bingLast._sum.impressions ?? 0,
          clicksPrior28: bingPrior._sum.clicks ?? 0,
          impressionsPrior28: bingPrior._sum.impressions ?? 0,
          topQueries: bingTop.map((q) => ({ query: q.query, clicks: q._sum.clicks ?? 0, impressions: q._sum.impressions ?? 0 })),
        }
      : null,
    aiAssistants: hasAi
      ? {
          sessions28: aiLast._sum.sessions ?? 0,
          sessionsPrior28: aiPrior._sum.sessions ?? 0,
          keyEvents28: Math.round(aiLast._sum.keyEvents ?? 0),
          topLanding: aiTop.map((r) => ({ page: r.path, sessions: r.sessions })),
        }
      : null,
    funnel: {
      last7: await funnelWeek(ago(GSC_LAG_DAYS + 7), end),
      prior7: await funnelWeek(ago(GSC_LAG_DAYS + 14), ago(GSC_LAG_DAYS + 7)),
      last28: await funnelWeek(ago(GSC_LAG_DAYS + 28), end),
      hasFunnelData: (await prisma.funnelOrganicDaily.count()) > 0,
    },
    indexation: {
      expected: inSitemap.length,
      indexed: inSitemap.filter((r) => r.verdict === "PASS").length,
      inspected: latest.length,
    },
    topOpportunities: open,
    byState: Object.fromEntries(states.map((s) => [s.state, s._count._all])),
    byLane: Object.fromEntries(lanes.map((s) => [s.lane, s._count._all])),
    stale,
    measurements: measurements.map((m) => ({ outcome: m.outcome, count: m._count._all })),
    heartbeats,
    discoverImpressions28d: discover._sum.impressions ?? 0,
  };
}

async function main(): Promise<number> {
  try {
    const input = await loadReportInput();
    const report = buildWeeklyReport(input);
    writeFileSync("weekly-report.md", report);
    console.log(report);
    if (!process.argv.includes("--no-telegram")) await sendTelegramMessage(buildTelegramSummary(input));
    return 0;
  } catch (error) {
    console.error("Weekly report failed:", error);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) main().then((code) => process.exit(code));
