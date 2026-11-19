// src/graduation/changeLedger.ts
// Registro de cambios SEO automáticos (riesgos 2 y 6 de la revisión). Lo corre el puente en cada
// pasada; es idempotente:
//   1. reconcile: cada tarea A1 terminada tiene su SeoChange; su despliegue es el primer
//      DeployEvent que trae su seo(<id8>). Sin despliegue a las 24 h, aviso (una vez).
//   2. measure: a los 28 días (+ retraso de GSC) desde el despliegue real, se mide su página
//      con la métrica de su operación. Otro cambio en la misma página en la ventana: no evaluable.
//      Un negativo no revierte a la primera: se confirma con una segunda ventana 14 días después;
//      si se confirma, se abre la reversión determinista (inverso exacto, la de runRevert).
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import { taskId8 } from "../bridge/guard";
import { computeOutcome, evaluableFrom, measurementWindows, GSC_LAG_DAYS, type OutcomeMetric, type WindowMetrics } from "./computeOutcome";
import { REGRESSION_TYPE, regressionKey } from "../revert/regression";

const DAY_MS = 24 * 60 * 60 * 1000;
export const NO_DEPLOY_ALERT_HOURS = 24;
export const CONFIRM_SHIFT_DAYS = 14;

/** Métrica que mide cada operación: los títulos se juzgan por CTR; lo demás, por clics. */
export function metricFor(operation: string | null): OutcomeMetric {
  return operation === "meta-title-description" ? "ctr" : "clicks";
}

type Sum = (page: string, start: Date, end: Date) => Promise<WindowMetrics>;

const sumGsc: Sum = async (page, start, end) => {
  const rows = await prisma.searchConsoleSnapshot.findMany({ where: { page, date: { gte: start, lt: end } }, select: { clicks: true, impressions: true, position: true } });
  const imp = rows.reduce((s, r) => s + r.impressions, 0);
  return {
    clicks: rows.reduce((s, r) => s + r.clicks, 0),
    impressions: imp,
    position: imp > 0 ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / imp : null,
  };
};

export async function reconcileChanges(now: Date, alert: typeof recordAlert = recordAlert): Promise<string[]> {
  const notes: string[] = [];
  const links = await prisma.seoTaskLink.findMany({ where: { autonomy: "A1", closeReason: "done" } });
  for (const link of links) {
    const auto = (link.contract as { publishPolicy?: string } | null)?.publishPolicy === "auto-merge-if-green";
    if (!auto) continue;
    const existing = await prisma.seoChange.findUnique({ where: { orbitaTaskId: link.orbitaTaskId } });
    if (existing) continue;
    await prisma.seoChange.create({
      data: {
        orbitaTaskId: link.orbitaTaskId,
        changeId8: taskId8(link.orbitaTaskId),
        stableKey: link.stableKey,
        findingType: link.findingType,
        operation: link.operation,
        page: link.page,
        status: link.findingType === "seo-canary" ? "not-evaluable" : "pending-deploy",
        createdAt: link.closedAt ?? now,
      },
    });
    notes.push(`registro: cambio ${taskId8(link.orbitaTaskId)} añadido`);
  }

  for (const c of await prisma.seoChange.findMany({ where: { OR: [{ status: "pending-deploy" }, { status: "not-evaluable", deployedAt: null }] } })) {
    const sameId8 = await prisma.seoTaskLink.count({ where: { orbitaTaskId: { startsWith: c.changeId8 } } });
    if (sameId8 > 1) {
      await prisma.seoChange.update({ where: { id: c.id }, data: { status: "ambiguous" } });
      notes.push(`registro: ${c.changeId8} ambiguo (dos tareas con el mismo id8)`);
      continue;
    }
    const deploy = await prisma.deployEvent.findFirst({ where: { seoChangeIds: { has: c.changeId8 } }, orderBy: { deployedAt: "asc" } });
    if (deploy) {
      await prisma.seoChange.update({
        where: { id: c.id },
        data: { deployCommitSha: deploy.commitSha, deployedAt: deploy.deployedAt, ...(c.status === "pending-deploy" ? { status: "deployed" } : {}) },
      });
      notes.push(`registro: ${c.changeId8} desplegado el ${deploy.deployedAt.toISOString().slice(0, 10)}`);
    } else if (c.status === "pending-deploy" && !c.alertedAt && now.getTime() - c.createdAt.getTime() > NO_DEPLOY_ALERT_HOURS * 3600_000) {
      await prisma.seoChange.update({ where: { id: c.id }, data: { alertedAt: now } });
      await alert({ type: "seo-change-no-deploy", subject: `Cambio SEO ${c.changeId8} sin desplegar`, body: `El cambio seo(${c.changeId8}) se fusionó hace más de ${NO_DEPLOY_ALERT_HOURS} h y ningún despliegue lo trae. No se mide hasta que se despliegue.` });
    }
  }
  return notes;
}

/** ¿Otro cambio SEO desplegado en la misma página entre el inicio de la ventana previa y el fin de la posterior? */
async function simultaneous(c: { id: string; page: string; deployedAt: Date }, end: Date): Promise<boolean> {
  const w = measurementWindows(c.deployedAt);
  return (await prisma.seoChange.count({ where: { id: { not: c.id }, page: c.page, deployedAt: { gte: w.before.start, lt: end } } })) > 0;
}

export async function measureChanges(now: Date, deps: { sum?: Sum; alert?: typeof recordAlert } = {}): Promise<string[]> {
  const sum = deps.sum ?? sumGsc;
  const alert = deps.alert ?? recordAlert;
  const notes: string[] = [];

  for (const c of await prisma.seoChange.findMany({ where: { status: "deployed", deployedAt: { not: null } } })) {
    if (!c.page || !c.deployedAt || now < evaluableFrom(c.deployedAt)) continue;
    const w = measurementWindows(c.deployedAt);
    const metric = metricFor(c.operation);
    const before = await sum(c.page, w.before.start, w.before.end);
    const after = await sum(c.page, w.after.start, w.after.end);
    const r = computeOutcome({ deployedAt: c.deployedAt, now, before, after, metric, mode: "low", simultaneousChange: await simultaneous({ id: c.id, page: c.page, deployedAt: c.deployedAt }, w.after.end) });
    if (r.outcome === "pending") continue;
    const detail = { metric, before, after, change: r.change, reason: r.reason } as object;
    if (r.outcome === "negative") {
      await prisma.seoChange.update({
        where: { id: c.id },
        data: { status: "negative-unconfirmed", outcome: "negative", outcomeDetail: detail, measuredAt: now, confirmAfter: new Date(w.after.end.getTime() + (CONFIRM_SHIFT_DAYS + GSC_LAG_DAYS) * DAY_MS) },
      });
      notes.push(`medición: ${c.changeId8} negativo, se confirma en ${CONFIRM_SHIFT_DAYS} días`);
      continue;
    }
    await prisma.seoChange.update({ where: { id: c.id }, data: { status: r.outcome === "not_evaluable" ? "not-evaluable" : "measured", outcome: r.outcome, outcomeDetail: detail, measuredAt: now } });
    notes.push(`medición: ${c.changeId8} ${r.outcome}`);
  }

  for (const c of await prisma.seoChange.findMany({ where: { status: "negative-unconfirmed", confirmAfter: { lte: now } } })) {
    if (!c.page || !c.deployedAt) continue;
    const w = measurementWindows(c.deployedAt);
    const shift = CONFIRM_SHIFT_DAYS * DAY_MS;
    const later = { start: new Date(w.after.start.getTime() + shift), end: new Date(w.after.end.getTime() + shift) };
    const before = await sum(c.page, w.before.start, w.before.end);
    const after = await sum(c.page, later.start, later.end);
    const r = computeOutcome({ deployedAt: c.deployedAt, now, before, after, metric: metricFor(c.operation), mode: "low", simultaneousChange: await simultaneous({ id: c.id, page: c.page, deployedAt: c.deployedAt }, later.end) });
    const confirmed = r.outcome === "negative";
    await prisma.seoChange.update({
      where: { id: c.id },
      data: { status: confirmed ? "reverted" : "measured", outcome: confirmed ? "negative" : r.outcome, outcomeDetail: { ...(c.outcomeDetail as object), confirmation: { after: { ...after }, change: r.change, reason: r.reason } } as object, measuredAt: now },
    });
    if (!confirmed) {
      notes.push(`medición: ${c.changeId8} no se confirma el negativo (${r.outcome})`);
      continue;
    }
    // misma vía que una regresión técnica: inverso exacto, CI y squash (runReverts)
    const stableKey = regressionKey(c.changeId8);
    if (!(await prisma.opportunity.findUnique({ where: { stableKey } }))) {
      await prisma.opportunity.create({
        data: {
          source: "seo-measurement",
          findingType: REGRESSION_TYPE,
          stableKey,
          sourceRefId: c.changeId8,
          title: `Impacto negativo confirmado del cambio seo(${c.changeId8}): se revierte`,
          detail: { changeId: c.changeId8, url: c.page, reasons: ["impacto negativo confirmado en dos ventanas"], deployedSha: c.deployCommitSha },
          page: c.page,
          operation: "revert-change",
          autonomy: "A1",
          lane: "urgent",
          severity: "high",
          impactScore: 50,
          confidenceScore: 1,
          effortScore: 1,
          priorityScore: 500,
          status: "open",
          state: "queued",
          stateChangedAt: now,
        },
      });
    }
    await alert({ type: "seo-change-negative", subject: `Cambio SEO ${c.changeId8}: impacto negativo confirmado, se revierte`, body: `La página empeora en las dos ventanas de medición (${metricFor(c.operation)}). Se abre la reversión determinista.` });
    notes.push(`medición: ${c.changeId8} negativo confirmado, reversión abierta`);
  }
  return notes;
}
