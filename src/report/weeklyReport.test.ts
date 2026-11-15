import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTelegramSummary, buildWeeklyReport, type ReportInput } from "./weeklyReport";

const week = (clicks: number, registros: number, bodasPublicadas = 0, pagos = 0, revenueCents = 0) => ({
  clicks,
  registros,
  bodasPublicadas,
  pagos,
  revenueCents,
});

function input(over: Partial<ReportInput> = {}): ReportInput {
  return {
    generatedAt: new Date("2026-11-16T08:00:00Z"),
    funnel: { last7: week(60, 6, 3, 1, 4900), prior7: week(40, 4, 2, 0), last28: week(200, 20, 10, 2, 9800), hasFunnelData: true },
    indexation: { expected: 120, indexed: 90, inspected: 140 },
    topOpportunities: [{ title: "Google ha dejado de indexar /precios", priorityScore: 27, lane: "urgent", autonomy: "A2", severity: "high" }],
    byState: { open: 12, resolved: 30, stale: 1 },
    byLane: { technical: 5, urgent: 1 },
    stale: [{ title: "Algo viejo" }],
    measurements: [{ outcome: "inconclusive", count: 3 }],
    heartbeats: [{ workflowName: "daily-collection", lastStatus: "ok", lastRunAt: new Date("2026-11-16T06:00:00Z") }],
    discoverImpressions28d: 0,
    ...over,
  };
}

test("el informe tiene las secciones fijas y las cifras", () => {
  const md = buildWeeklyReport(input());
  for (const h of ["## Embudo orgánico", "## Indexación", "## Top 10 de oportunidades", "## Hallazgos por estado y carril", "## Cambios medidos", "## Procesos"]) {
    assert.ok(md.includes(h), h);
  }
  assert.ok(md.includes("| Clics orgánicos (GSC) | 60 | 40 | +50% | 200 |"));
  assert.ok(md.includes("| Ingresos | 49 € | 0 € | nuevo | 98 € |"));
  assert.ok(md.includes("90 de 120 URLs del sitemap indexadas"));
  assert.ok(md.includes("clic → registro 10.0%"));
  assert.ok(md.includes("- Algo viejo"));
  assert.ok(!md.includes("Discover pasa"));
});

test("sin embudo de la app lo dice, y avisa de Discover al pasar el umbral", () => {
  const md = buildWeeklyReport(input({ funnel: { ...input().funnel, hasFunnelData: false }, discoverImpressions28d: 600 }));
  assert.ok(md.includes("Sin datos del embudo"));
  assert.ok(md.includes("Discover pasa de 500"));
});

test("es determinista", () => {
  assert.equal(buildWeeklyReport(input()), buildWeeklyReport(input()));
});

test("el resumen de Telegram escapa HTML y avisa de procesos que fallan", () => {
  const t = buildTelegramSummary(
    input({
      topOpportunities: [{ title: "a <b> & c", priorityScore: 1, lane: "technical", autonomy: "A2", severity: "low" }],
      heartbeats: [{ workflowName: "weekly-sync", lastStatus: "failed", lastRunAt: new Date() }],
    }),
  );
  assert.ok(t.includes("a &lt;b&gt; &amp; c"));
  assert.ok(t.includes("Fallan: weekly-sync"));
  assert.ok(t.includes("Indexadas 90/120"));
});

test("la sección de Bing sale solo con datos y compara con los 28 días anteriores", () => {
  assert.ok(!buildWeeklyReport(input()).includes("## Bing"));
  const md = buildWeeklyReport(
    input({ bing: { clicks28: 4, impressions28: 300, clicksPrior28: 2, impressionsPrior28: 150, topQueries: [{ query: "web de boda", clicks: 1, impressions: 40 }] } }),
  );
  assert.match(md, /## Bing\n\n28 días: 4 clics \(\+100%\) y 300 impresiones \(\+100%\)\./);
  assert.match(md, /«web de boda» 40/);
});
