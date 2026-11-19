// src/report/weeklyReport.ts
// Informe semanal (§20): determinista, a partir de los datos. Lógica pura: el
// script scripts/weekly-report.ts carga las filas y lo publica. Sin URLs de
// páginas privadas: los hallazgos de privacidad ya llegan sin ellas.

export interface FunnelWeek {
  /** Clics orgánicos web de GSC (días finales). */
  clicks: number;
  registros: number;
  bodasPublicadas: number;
  pagos: number;
  revenueCents: number;
}

export interface ReportInput {
  generatedAt: Date;
  funnel: { last7: FunnelWeek; prior7: FunnelWeek; last28: FunnelWeek; hasFunnelData: boolean };
  indexation: { expected: number; indexed: number; inspected: number };
  topOpportunities: { title: string; priorityScore: number; lane: string; autonomy: string; severity: string }[];
  byState: Record<string, number>;
  byLane: Record<string, number>;
  stale: { title: string }[];
  measurements: { outcome: string; count: number }[];
  heartbeats: { workflowName: string; lastStatus: string; lastRunAt: Date }[];
  discoverImpressions28d: number;
  /** Bing Webmaster (fase 6), últimos 28 días frente a los 28 anteriores; null si aún no hay datos. */
  bing?: { clicks28: number; impressions28: number; clicksPrior28: number; impressionsPrior28: number; topQueries: { query: string; clicks: number; impressions: number }[] } | null;
  /**
   * Visitas que llegan desde asistentes de IA (canal «AI Assistant» de GA4, solo
   * con analítica aceptada), 28 días frente a los 28 anteriores. Es lo único
   * observable: ninguna IA publica impresiones ni posiciones.
   */
  aiAssistants?: { sessions28: number; sessionsPrior28: number; keyEvents28: number; topLanding: { page: string; sessions: number }[] } | null;
}

const DISCOVER_THRESHOLD = 500;

function delta(now: number, before: number): string {
  if (before === 0) return now === 0 ? "=" : "nuevo";
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

function rate(num: number, den: number): string {
  return den === 0 ? "-" : `${((num / den) * 100).toFixed(1)}%`;
}

function euros(cents: number): string {
  return `${(cents / 100).toFixed(0)} €`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Informe completo en Markdown (artefacto del workflow y comentario en Órbita). */
export function buildWeeklyReport(input: ReportInput): string {
  const { funnel, indexation } = input;
  const day = input.generatedAt.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# Informe SEO semanal (${day})`, "");

  lines.push("## Embudo orgánico", "");
  if (!funnel.hasFunnelData) {
    lines.push("Sin datos del embudo de la app todavía (falta `APP_FUNNEL_DATABASE_URL`). Solo hay clics de Search Console.", "");
  }
  lines.push("| | 7 días | 7 anteriores | Δ | 28 días |", "|---|---|---|---|---|");
  const row = (label: string, k: keyof FunnelWeek, fmt: (n: number) => string = String) =>
    lines.push(`| ${label} | ${fmt(funnel.last7[k])} | ${fmt(funnel.prior7[k])} | ${delta(funnel.last7[k], funnel.prior7[k])} | ${fmt(funnel.last28[k])} |`);
  row("Clics orgánicos (GSC)", "clicks");
  row("Registros", "registros");
  row("Webs publicadas", "bodasPublicadas");
  row("Pagos", "pagos");
  row("Ingresos", "revenueCents", euros);
  lines.push("");
  if (funnel.hasFunnelData) lines.push(
    `Conversión 28 días: clic → registro ${rate(funnel.last28.registros, funnel.last28.clicks)}, registro → web publicada ${rate(funnel.last28.bodasPublicadas, funnel.last28.registros)}, web publicada → pago ${rate(funnel.last28.pagos, funnel.last28.bodasPublicadas)}.`,
    "",
  );

  lines.push("## Indexación", "");
  lines.push(
    `${indexation.indexed} de ${indexation.expected} URLs del sitemap indexadas según la última inspección (${indexation.inspected} inspeccionadas).`,
    "",
  );

  lines.push("## Top 10 de oportunidades", "");
  if (input.topOpportunities.length === 0) lines.push("Ninguna abierta.");
  input.topOpportunities.forEach((o, i) =>
    lines.push(`${i + 1}. ${o.title} (prioridad ${o.priorityScore.toFixed(1)}, ${o.lane}, ${o.autonomy}, ${o.severity})`),
  );
  lines.push("");

  lines.push("## Hallazgos por estado y carril", "");
  const fmtCounts = (r: Record<string, number>) =>
    Object.entries(r)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k} ${n}`)
      .join(", ") || "ninguno";
  lines.push(`Estado: ${fmtCounts(input.byState)}.`, `Carril (abiertos): ${fmtCounts(input.byLane)}.`, "");
  if (input.stale.length > 0) {
    lines.push("Sin resolver tras 60 días (`stale`, no generan tareas nuevas):");
    for (const s of input.stale) lines.push(`- ${s.title}`);
    lines.push("");
  }

  lines.push("## Cambios medidos", "");
  lines.push(
    input.measurements.length === 0
      ? "Ninguna medición todavía."
      : input.measurements.map((m) => `${m.outcome} ${m.count}`).join(", ") + ".",
    "",
  );

  if (input.bing) {
    const b = input.bing;
    lines.push("## Bing", "");
    lines.push(
      `28 días: ${b.clicks28} clics (${delta(b.clicks28, b.clicksPrior28)}) y ${b.impressions28} impresiones (${delta(b.impressions28, b.impressionsPrior28)}).`,
    );
    if (b.topQueries.length) lines.push(`Consultas no-marca con más impresiones: ${b.topQueries.map((q) => `«${q.query}» ${q.impressions}`).join(", ")}.`);
    lines.push("");
  }

  if (input.aiAssistants) {
    const a = input.aiAssistants;
    lines.push("## Asistentes de IA", "");
    lines.push(
      `28 días: ${a.sessions28} visitas desde ChatGPT, Perplexity, Gemini y similares (${delta(a.sessions28, a.sessionsPrior28)}), ${a.keyEvents28} conversiones. Solo cuenta visitas con analítica aceptada; las IA no publican impresiones.`,
    );
    if (a.topLanding.length) lines.push(`Páginas por las que entran: ${a.topLanding.map((l) => `${l.page} ${l.sessions}`).join(", ")}.`);
    lines.push("");
  }

  lines.push("## Procesos", "");
  for (const h of [...input.heartbeats].sort((a, b) => a.workflowName.localeCompare(b.workflowName))) {
    lines.push(`- ${h.workflowName}: ${h.lastStatus} (${h.lastRunAt.toISOString().slice(0, 16).replace("T", " ")} UTC)`);
  }
  lines.push("");

  if (input.discoverImpressions28d >= DISCOVER_THRESHOLD) {
    lines.push(`Discover pasa de ${DISCOVER_THRESHOLD} impresiones en 28 días (${input.discoverImpressions28d}): se pueden activar sus detectores.`, "");
  }
  return lines.join("\n");
}

/** Resumen corto para Telegram (HTML). */
export function buildTelegramSummary(input: ReportInput): string {
  const f = input.funnel;
  const urgent = input.topOpportunities.filter((o) => o.lane === "urgent").length;
  const failing = input.heartbeats.filter((h) => !/^(ok|success)$/i.test(h.lastStatus)).map((h) => h.workflowName);
  const parts = [
    `📊 <b>Informe SEO semanal</b>`,
    `Clics ${f.last7.clicks} (${delta(f.last7.clicks, f.prior7.clicks)}) · registros ${f.last7.registros} · publicadas ${f.last7.bodasPublicadas} · pagos ${f.last7.pagos}`,
    `Indexadas ${input.indexation.indexed}/${input.indexation.expected}`,
    ...(input.bing ? [`Bing 28 días: ${input.bing.clicks28} clics · ${input.bing.impressions28} impresiones`] : []),
    `Abiertas: ${input.byState.open ?? 0}${urgent ? ` · urgentes en el top: ${urgent}` : ""}`,
  ];
  if (input.topOpportunities[0]) parts.push(`1.º ${escapeHtml(input.topOpportunities[0].title)}`);
  if (failing.length) parts.push(`⚠️ Fallan: ${failing.join(", ")}`);
  return parts.join("\n");
}
