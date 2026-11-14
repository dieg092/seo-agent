// src/brake/control.ts
// Lectura y cambios de SeoControl (fila única) y la evaluación del freno con
// datos reales. Cada cambio deja una Alert (BD y Telegram).
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import { latestInspections } from "../detectors/annexB";
import { evaluateBrake, type BrakeDecision, type BrakeInputs, type ControlState } from "./brake";

const ID = "global";
const DAY_MS = 24 * 60 * 60 * 1000;
const GSC_LAG_DAYS = 3;

/** Control actual, o null si no se puede leer (quien lo use debe cerrar lo SEO). */
export async function readControl(): Promise<ControlState | null> {
  try {
    const row = await prisma.seoControl.upsert({ where: { id: ID }, create: { id: ID }, update: {} });
    return { masterSwitch: row.masterSwitch, pausedLanes: row.pausedLanes, brakeState: row.brakeState };
  } catch (error) {
    console.error("No se pudo leer SeoControl:", error);
    return null;
  }
}

export async function setSwitch(on: boolean, reason: string): Promise<void> {
  await prisma.seoControl.upsert({ where: { id: ID }, create: { id: ID, masterSwitch: on ? "on" : "off" }, update: { masterSwitch: on ? "on" : "off" } });
  await recordAlert({ type: "seo-switch", subject: `Interruptor SEO ${on ? "encendido" : "apagado"}`, body: reason });
}

export async function setLanePaused(lane: string, paused: boolean, reason: string): Promise<void> {
  const row = await prisma.seoControl.upsert({ where: { id: ID }, create: { id: ID }, update: {} });
  const lanes = new Set(row.pausedLanes);
  if (paused) lanes.add(lane);
  else lanes.delete(lane);
  await prisma.seoControl.update({ where: { id: ID }, data: { pausedLanes: [...lanes].sort() } });
  await recordAlert({ type: "seo-lane", subject: `Carril SEO ${lane} ${paused ? "en pausa" : "reanudado"}`, body: reason });
}

export async function trip(reasons: string[], by: string): Promise<void> {
  const row = await prisma.seoControl.upsert({ where: { id: ID }, create: { id: ID }, update: {} });
  if (row.brakeState === "tripped") return;
  await prisma.seoControl.update({
    where: { id: ID },
    data: { brakeState: "tripped", brakeReason: reasons.join("; ").slice(0, 2000), trippedAt: new Date(), trippedBy: by },
  });
  await recordAlert({
    type: "seo-brake-tripped",
    subject: "Freno SEO activado",
    body: `${reasons.join("\n")}\n\nSe rearma solo a mano: pnpm seo:switch rearm --reason "…"`,
  });
}

/** Rearme manual, con motivo (anexo C.6). */
export async function rearm(reason: string): Promise<void> {
  await prisma.seoControl.upsert({
    where: { id: ID },
    create: { id: ID },
    update: { brakeState: "off", brakeReason: null, trippedAt: null, trippedBy: `rearme manual: ${reason}`.slice(0, 500) },
  });
  await recordAlert({ type: "seo-brake-rearmed", subject: "Freno SEO rearmado", body: reason });
}

async function indexedAt(at: Date): Promise<number> {
  const rows = await prisma.urlInspection.findMany({ where: { inspectedAt: { gte: new Date(at.getTime() - 30 * DAY_MS), lte: at } } });
  const latest = [...latestInspections(rows).values()].map((l) => l[0]);
  return latest.filter((r) => r.inSitemap && r.verdict === "PASS").length;
}

export async function loadBrakeInputs(now: Date = new Date()): Promise<BrakeInputs> {
  const ago = (d: number) => new Date(now.getTime() - d * DAY_MS);
  const recentLinks = await prisma.seoTaskLink.findMany({
    where: { taskStatus: { in: ["blocked", "done", "cancelled"] } },
    orderBy: { lastSyncedAt: "desc" },
    take: 5,
    select: { taskStatus: true },
  });
  const sum = async (from: Date, to: Date) =>
    (await prisma.searchConsolePageDaily.aggregate({ where: { type: "web", date: { gte: from, lt: to } }, _sum: { impressions: true } }))._sum.impressions ?? 0;
  const end = ago(GSC_LAG_DAYS);

  // Días recientes (ya cerrados) sin datos de páginas de GSC.
  let failDays = 0;
  for (let d = GSC_LAG_DAYS + 1; d <= GSC_LAG_DAYS + 3; d++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - d * DAY_MS);
    const row = await prisma.gscDataQuality.findFirst({ where: { date: day, type: "web", dataset: "page" } });
    if (row) break;
    failDays += 1;
  }

  return {
    indexedNow: await indexedAt(now),
    indexed7dAgo: await indexedAt(ago(7)),
    openPrivateIncidents: await prisma.privateIncident.count({ where: { resolvedAt: null } }),
    recentTaskOutcomes: recentLinks.map((l) => l.taskStatus),
    tasksCreated24h: await prisma.seoTaskLink.count({ where: { createdAt: { gte: ago(1) } } }),
    impressions7d: await sum(ago(GSC_LAG_DAYS + 7), end),
    impressionsPrior7d: await sum(ago(GSC_LAG_DAYS + 14), ago(GSC_LAG_DAYS + 7)),
    criticalCollectorFailDays: failDays,
  };
}

/** Evalúa el freno con los datos reales y lo aplica: salta solo, nunca se rearma solo. */
export async function evaluateAndApply(now: Date = new Date()): Promise<BrakeDecision> {
  const decision = evaluateBrake(await loadBrakeInputs(now));
  if (decision.trip) await trip(decision.reasons, "evaluate-brake");
  const control = await readControl();
  for (const lane of decision.pauseLanes) {
    if (control && !control.pausedLanes.includes(lane)) {
      await setLanePaused(lane, true, "calidad de datos: GSC sin datos 2 días seguidos (§14)");
    }
  }
  return decision;
}
