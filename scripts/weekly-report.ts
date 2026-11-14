// scripts/weekly-report.ts
// Informe semanal (§20). Lee seo_agent, escribe weekly-report.md (artefacto del
// workflow) y manda el resumen por Telegram. Solo lectura en la BD.
import { writeFileSync } from "node:fs";
import { prisma } from "../src/db";
import { buildTelegramSummary, buildWeeklyReport, type FunnelWeek, type ReportInput } from "../src/report/weeklyReport";
import { latestInspections } from "../src/detectors/annexB";
import { ORGANIC_CHANNELS } from "../src/detectors/annexB";
import { sendTelegramMessage } from "../src/alerts/sendTelegramMessage";

const DAY_MS = 24 * 60 * 60 * 1000;
const GSC_LAG_DAYS = 3;

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

  return {
    generatedAt: now,
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
