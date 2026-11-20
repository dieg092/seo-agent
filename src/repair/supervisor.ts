// src/repair/supervisor.ts
// Supervisor de autorreparación de seo-agent (plan de Codex, 2026-11-20). Cada pasada:
//   1. ingiere los avisos nuevos y los agrupa en incidencias (clave = tipo + componente + firma);
//   2. clasifica sin modelo: transitorio (esperar), fundador (avisar una vez con el paso),
//      código (reparar), resto (ignorar);
//   3. vigila heartbeats atrasados y relanza el proceso si es local;
//   4. repara como mucho UNA incidencia: agente aislado → guarda del diff → puerta local →
//      PR fusionado → checkout del Mac actualizado;
//   5. verifica las reparaciones fusionadas y revierte si aparece un fallo nuevo en el componente.
// Límites: 2 ejecuciones del modelo por incidencia (≥ 6 h entre ellas), 2 al día en total, cada
// una reserva una llamada de fondo del presupuesto editorial; nunca con Órbita usando el modelo.
import { prisma } from "../db";
import { redactText } from "../privacy/outboundPolicy";
import { classifyAlert, incidentKey, promoteTransient, type AlertInput } from "./classify";
import { guardDiff, type DiffFile } from "./guard";
import { parseReport, repairPrompt, safeCommitMessage, type RepairReport } from "./contract";
import type { AgentRun } from "./sandbox";

export const MAX_RUNS_PER_INCIDENT = 2;
export const MAX_RUNS_PER_DAY = 2;
export const RETRY_GAP_MS = 6 * 3_600_000;
export const RUNNING_STALE_MS = 2 * 3_600_000;
const HOUR = 3_600_000;

/** Cadencia esperada de cada proceso con heartbeat; label = LaunchAgent del Mac (se relanza solo). */
export const CADENCE: Record<string, { everyMs: number; label?: string }> = {
  "seo-bridge": { everyMs: 15 * 60_000, label: "com.miwebdeboda.seo-bridge" },
  "seo-tick": { everyMs: 30 * 60_000, label: "com.miwebdeboda.seo-tick" },
  "daily-collection": { everyMs: 24 * HOUR },
  "weekly-embeddings-and-briefing": { everyMs: 7 * 24 * HOUR },
  "monthly-site-architecture": { everyMs: 32 * 24 * HOUR },
};

/** Ventana de verificación tras fusionar: dos ejecuciones esperadas del componente (mín. 2 h, máx. 3 días). */
export function verifyWindowMs(component: string): number {
  const every = CADENCE[component]?.everyMs ?? 24 * HOUR;
  return Math.min(Math.max(2 * every + HOUR, 2 * HOUR), 72 * HOUR);
}

export interface Workspace {
  dir: string;
  baseSha: string;
  dispose: () => void;
}

export interface SupervisorDeps {
  now: () => Date;
  notify: (a: { type: string; subject: string; body: string }) => Promise<void>;
  /** Reserva una llamada de fondo; lanza si no hay presupuesto, hay límite de cupo u Órbita está ocupada. */
  reserve: (now: Date) => Promise<void>;
  createWorkspace: () => Workspace;
  runAgent: (dir: string, prompt: string) => Promise<AgentRun>;
  diff: (dir: string) => DiffFile[];
  gate: (dir: string) => { ok: boolean; detail: string };
  publish: (dir: string, branch: string, message: string, body: string) => { prUrl: string; mergedSha: string };
  revert: (sha: string, branch: string, message: string) => { prUrl: string; mergedSha: string };
  updateMain: () => { ok: boolean; reason?: string };
  evidence: (component: string, alertType: string, alertText: string) => string;
  kickstart: (label: string) => boolean;
}

type Incident = Awaited<ReturnType<typeof prisma.repairIncident.findFirstOrThrow>>;
type Runs = { at: string; verdict: string; detail?: string }[];

function runsOf(i: Incident): Runs {
  const r = (i.result as { runs?: Runs } | null)?.runs;
  return Array.isArray(r) ? r : [];
}

function withRun(i: Incident, run: Runs[number], extra: Record<string, unknown> = {}) {
  const prev = (i.result as Record<string, unknown> | null) ?? {};
  return { ...prev, ...extra, runs: [...runsOf(i), run] };
}

/** 1-2. Ingesta y clasificación. Devuelve cuántas incidencias se tocaron. */
export async function ingest(alerts: (AlertInput & { createdAt: Date })[], deps: Pick<SupervisorDeps, "notify" | "now">): Promise<number> {
  let touched = 0;
  for (const a of alerts) {
    const c = classifyAlert(a);
    if (c.kind === "ignore") continue;
    const key = incidentKey(a.type, c.component, c.signature);
    const existing = await prisma.repairIncident.findUnique({ where: { key } });
    touched += 1;
    if (!existing) {
      const created = await prisma.repairIncident.create({
        data: {
          key,
          alertType: a.type,
          component: c.component,
          signature: c.signature,
          kind: c.kind,
          status: c.kind === "code" ? "open" : c.kind === "transient" ? "waiting" : "escalated",
          firstSeenAt: a.createdAt,
          lastSeenAt: a.createdAt,
          nextAttemptAt: a.createdAt,
          result: { lastAlert: redactText(`${a.subject}\n${a.body}`).slice(0, 2000) },
        },
      });
      if (c.kind === "founder") await escalate(created, c.founderStep!, deps);
      continue;
    }
    const lastAlert = redactText(`${a.subject}\n${a.body}`).slice(0, 2000);
    const data: Record<string, unknown> = {
      occurrences: { increment: 1 },
      lastSeenAt: a.createdAt > existing.lastSeenAt ? a.createdAt : existing.lastSeenAt,
      result: { ...((existing.result as object) ?? {}), lastAlert },
    };
    // Reaparece algo que se dio por resuelto: nueva generación con los mismos límites.
    if (existing.status === "resolved" && a.createdAt > existing.updatedAt) {
      data.status = existing.kind === "code" ? "open" : existing.kind === "transient" ? "waiting" : "escalated";
      data.nextAttemptAt = deps.now();
    }
    const updated = await prisma.repairIncident.update({ where: { id: existing.id }, data });
    // Lo que necesita al fundador y sigue pasando una semana después se vuelve a avisar.
    if (c.kind === "founder" && existing.status === "escalated" && existing.notifiedAt && a.createdAt.getTime() - existing.notifiedAt.getTime() > 7 * 24 * HOUR) {
      await escalate({ ...updated, notifiedAt: null }, c.founderStep!, deps);
    }
  }
  // Transitorios que se repiten durante horas: pasan a código (falta un reintento o algo peor).
  for (const t of await prisma.repairIncident.findMany({ where: { kind: "transient", status: "waiting" } })) {
    if (promoteTransient(t.occurrences, t.firstSeenAt, t.lastSeenAt)) {
      await prisma.repairIncident.update({ where: { id: t.id }, data: { kind: "code", status: "open", nextAttemptAt: deps.now() } });
    }
  }
  return touched;
}

async function escalate(i: Incident, step: string, deps: Pick<SupervisorDeps, "notify" | "now">, why = "necesita algo que solo puedes hacer tú") {
  if (i.notifiedAt) return;
  await deps.notify({
    type: "seo-repair-founder",
    subject: `Autorreparación: ${i.component} ${why}`,
    body: `${step}\nIncidencia ${i.id.slice(0, 8)} (${i.alertType}, vista ${i.occurrences} vez/veces).`,
  });
  await prisma.repairIncident.update({ where: { id: i.id }, data: { status: "escalated", notifiedAt: deps.now() } });
}

/** 3. Heartbeats atrasados: relanza el LaunchAgent; si es de GitHub o no revive, avisa una vez. */
export async function checkHeartbeats(deps: Pick<SupervisorDeps, "now" | "notify" | "kickstart">): Promise<void> {
  const now = deps.now();
  for (const hb of await prisma.workflowHeartbeat.findMany()) {
    const cad = CADENCE[hb.workflowName];
    if (!cad) continue;
    const late = now.getTime() - hb.lastRunAt.getTime() > 2 * cad.everyMs + 30 * 60_000;
    const key = incidentKey("heartbeat-stale", hb.workflowName, "stale");
    const inc = await prisma.repairIncident.findUnique({ where: { key } });
    if (!late) {
      if (inc && inc.status !== "resolved") await prisma.repairIncident.update({ where: { id: inc.id }, data: { status: "resolved", notifiedAt: null } });
      continue;
    }
    const row =
      inc ??
      (await prisma.repairIncident.create({
        data: { key, alertType: "heartbeat-stale", component: hb.workflowName, signature: "stale", kind: "founder", status: "waiting", firstSeenAt: now, lastSeenAt: now },
      }));
    if (row.status === "resolved") await prisma.repairIncident.update({ where: { id: row.id }, data: { status: "waiting", occurrences: { increment: 1 }, lastSeenAt: now } });
    const tried = (row.result as { kickstartAt?: string } | null)?.kickstartAt;
    if (cad.label && !tried) {
      const ok = deps.kickstart(cad.label);
      await prisma.repairIncident.update({ where: { id: row.id }, data: { result: { kickstartAt: now.toISOString(), kickstartOk: ok } } });
      continue;
    }
    // Ya se relanzó (o no es del Mac) y sigue sin latir pasada otra cadencia: aviso único.
    if (!tried || now.getTime() - Date.parse(tried) > cad.everyMs + 30 * 60_000) {
      const step = cad.label
        ? `El proceso ${hb.workflowName} no da señales desde ${hb.lastRunAt.toISOString().slice(0, 16)} UTC ni tras relanzarlo. Probablemente el Mac estuvo apagado o dormido; si sigue así con el Mac encendido, ejecuta: launchctl kickstart -k gui/$(id -u)/${cad.label}`
        : `El workflow ${hb.workflowName} de GitHub no se ejecuta desde ${hb.lastRunAt.toISOString().slice(0, 16)} UTC. Comprueba en GitHub > Actions que no esté desactivado; si lo está, actívalo con: gh workflow enable ${hb.workflowName}.yml -R dieg092/seo-agent`;
      await escalate(row, step, deps, "no da señales");
    }
  }
}

/** Recuperación tras un corte: una reparación «running» abandonada vuelve a abierta (el intento cuenta). */
export async function recoverStale(deps: Pick<SupervisorDeps, "now">): Promise<void> {
  const cutoff = new Date(deps.now().getTime() - RUNNING_STALE_MS);
  await prisma.repairIncident.updateMany({ where: { status: "running", updatedAt: { lt: cutoff } }, data: { status: "open", nextAttemptAt: new Date(deps.now().getTime() + RETRY_GAP_MS) } });
}

async function runsToday(now: Date): Promise<number> {
  const since = now.getTime() - 24 * HOUR;
  const rows = await prisma.repairIncident.findMany({ where: { updatedAt: { gte: new Date(since) } } });
  return rows.reduce((n, i) => n + runsOf(i).filter((r) => Date.parse(r.at) >= since && r.verdict !== "aplazado").length, 0);
}

/** 4. Repara como mucho una incidencia. Devuelve una línea para el log. */
export async function repairOne(mainDir: string, deps: SupervisorDeps): Promise<string> {
  const now = deps.now();
  if (await prisma.repairIncident.findFirst({ where: { status: { in: ["running", "merged-pending-update"] } } })) return "reparación: hay otra en curso";
  const inc = await prisma.repairIncident.findFirst({
    where: { kind: "code", status: "open", attempts: { lt: MAX_RUNS_PER_INCIDENT }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: [{ occurrences: "desc" }, { firstSeenAt: "asc" }],
  });
  if (!inc) return "reparación: nada pendiente";
  if ((await runsToday(now)) >= MAX_RUNS_PER_DAY) return "reparación: tope diario alcanzado";
  try {
    await deps.reserve(now);
  } catch (e) {
    return `reparación aplazada: ${(e as Error).message}`;
  }

  // Bloqueo optimista: solo una pasada se queda la incidencia.
  const claimed = await prisma.repairIncident.updateMany({ where: { id: inc.id, status: "open" }, data: { status: "running", attempts: { increment: 1 } } });
  if (claimed.count === 0) return "reparación: otra pasada se la ha quedado";
  const attempt = inc.attempts + 1;
  const lastAlert = (inc.result as { lastAlert?: string } | null)?.lastAlert ?? "";
  const ws = deps.createWorkspace();
  const finish = async (status: string, verdict: string, detail: string, extra: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => {
    const fresh = await prisma.repairIncident.findUniqueOrThrow({ where: { id: inc.id } });
    const retry = status === "open" && attempt < MAX_RUNS_PER_INCIDENT;
    await prisma.repairIncident.update({
      where: { id: inc.id },
      data: {
        status: status === "open" && !retry ? "escalated" : status,
        nextAttemptAt: retry ? new Date(now.getTime() + RETRY_GAP_MS) : null,
        result: withRun(fresh, { at: now.toISOString(), verdict, detail: detail.slice(0, 600) }, extra),
        ...data,
      },
    });
    if (status === "open" && !retry) {
      await deps.notify({
        type: "seo-repair-escalated",
        subject: `Autorreparación: no he podido arreglar ${inc.component}`,
        body: `Tras ${attempt} intento(s): ${detail.slice(0, 500)}\nNo hace falta que hagas nada ahora: abre una sesión de Claude Code cuando puedas y dile «revisa la incidencia ${inc.id.slice(0, 8)} de autorreparación».`,
      });
      await prisma.repairIncident.update({ where: { id: inc.id }, data: { notifiedAt: now } });
    }
    return `reparación ${inc.id.slice(0, 8)} (${inc.component}): ${verdict} — ${detail.slice(0, 200)}`;
  };

  try {
    const evidence = deps.evidence(inc.component, inc.alertType, lastAlert);
    const run = await deps.runAgent(ws.dir, repairPrompt({ incidentId: inc.id.slice(0, 8), alertType: inc.alertType, component: inc.component, occurrences: inc.occurrences, evidence }));
    if (!run.ok) return await finish("open", "error-agente", run.error ?? "sin detalle");
    const report: RepairReport | null = parseReport(run.text);
    if (!report) return await finish("open", "salida-invalida", "el agente no devolvió un JSON válido");
    const files = deps.diff(ws.dir);

    if (report.veredicto !== "reparado") {
      if (files.length) return await finish("open", "incoherente", `dice ${report.veredicto} pero cambió ${files.length} fichero(s)`);
      if (report.veredicto === "necesita_fundador" && report.paso_fundador) {
        const fresh = await prisma.repairIncident.findUniqueOrThrow({ where: { id: inc.id } });
        await prisma.repairIncident.update({ where: { id: inc.id }, data: { result: withRun(fresh, { at: now.toISOString(), verdict: report.veredicto, detail: report.diagnostico }) } });
        await escalate(fresh, `${report.diagnostico}\nQué hacer: ${report.paso_fundador}`, deps);
        return `reparación ${inc.id.slice(0, 8)}: necesita al fundador`;
      }
      return await finish("resolved", report.veredicto, report.diagnostico);
    }

    const g = guardDiff(files);
    if (!g.ok) return await finish("open", "guarda", `diff rechazado: ${g.reasons.join("; ")}`);
    const gate = deps.gate(ws.dir);
    if (!gate.ok) return await finish("open", "puerta-local", gate.detail);

    const message = safeCommitMessage(report.commit, inc.component);
    const branch = `repair/${inc.id.slice(0, 8)}-${attempt}`;
    const body = `Reparación automática de seo-agent.\n\nIncidencia ${inc.id.slice(0, 8)} (${inc.alertType}, ${inc.component}).\n\n${report.diagnostico}\n\nPuerta local: ${gate.detail}.`;
    const pub = deps.publish(ws.dir, branch, message, body);
    const upd = deps.updateMain();
    return await finish(
      upd.ok ? "verifying" : "merged-pending-update",
      "reparado",
      `${report.diagnostico} (${pub.prUrl})`,
      { files: files.map((f) => f.path), gate: gate.detail, mergedAt: now.toISOString() },
      { prUrl: pub.prUrl, baseSha: ws.baseSha, mergedSha: pub.mergedSha, verifyUntil: new Date(now.getTime() + verifyWindowMs(inc.component)) }
    );
  } catch (e) {
    return await finish("open", "error", redactText(String((e as Error).message ?? e)));
  } finally {
    ws.dispose();
  }
}

/** 5. Verificación de lo fusionado y reversión si empeora. */
export async function verifyMerged(deps: Pick<SupervisorDeps, "now" | "notify" | "revert" | "updateMain">): Promise<string[]> {
  const now = deps.now();
  const log: string[] = [];
  for (const p of await prisma.repairIncident.findMany({ where: { status: "merged-pending-update" } })) {
    const upd = deps.updateMain();
    if (upd.ok) await prisma.repairIncident.update({ where: { id: p.id }, data: { status: "verifying" } });
    else if (!p.notifiedAt && now.getTime() - p.updatedAt.getTime() > HOUR) {
      await deps.notify({ type: "seo-repair-founder", subject: "Autorreparación: no puedo actualizar el checkout de seo-agent", body: `La reparación está fusionada en GitHub pero el checkout del Mac no se actualiza (${upd.reason}). Cuando acabes lo que tengas a medias en seo-agent, ejecuta: cd ~/Projects/production/miwebdeboda/seo-agent && git pull --ff-only` });
      await prisma.repairIncident.update({ where: { id: p.id }, data: { notifiedAt: now } });
    }
  }
  for (const v of await prisma.repairIncident.findMany({ where: { status: "verifying" } })) {
    const mergedAt = new Date((v.result as { mergedAt?: string } | null)?.mergedAt ?? v.updatedAt);
    // Fallo NUEVO en el mismo componente después de fusionar: la reparación lo ha empeorado.
    const fresh = await prisma.repairIncident.findFirst({ where: { component: v.component, id: { not: v.id }, kind: "code", firstSeenAt: { gt: mergedAt } } });
    if (fresh && v.mergedSha) {
      try {
        const r = deps.revert(v.mergedSha, `repair/revert-${v.id.slice(0, 8)}`, `revierte reparacion de ${v.component}`.slice(0, 60));
        deps.updateMain();
        await prisma.repairIncident.update({ where: { id: v.id }, data: { status: "reverted", notifiedAt: now } });
        await deps.notify({ type: "seo-repair-reverted", subject: `Autorreparación revertida: ${v.component}`, body: `Tras la reparación apareció un fallo nuevo en ${v.component}; se ha revertido (${r.prUrl}). La incidencia queda para revisión.` });
        log.push(`verificación ${v.id.slice(0, 8)}: revertida`);
      } catch (e) {
        await prisma.repairIncident.update({ where: { id: v.id }, data: { status: "escalated", notifiedAt: now } });
        await deps.notify({ type: "seo-repair-founder", subject: `Autorreparación: no se pudo revertir ${v.component}`, body: `La reparación ${v.prUrl ?? ""} coincide con un fallo nuevo y la reversión automática ha fallado (${redactText(String((e as Error).message)).slice(0, 300)}). Abre Claude Code y dile «revisa la incidencia ${v.id.slice(0, 8)} de autorreparación».` });
        log.push(`verificación ${v.id.slice(0, 8)}: reversión fallida`);
      }
      continue;
    }
    // El mismo fallo vuelve: la reparación no bastó (sin revertir: ya fallaba antes).
    if (v.lastSeenAt > mergedAt) {
      const retry = v.attempts < MAX_RUNS_PER_INCIDENT;
      await prisma.repairIncident.update({ where: { id: v.id }, data: { status: retry ? "open" : "escalated", nextAttemptAt: retry ? new Date(now.getTime() + RETRY_GAP_MS) : null } });
      if (!retry) await deps.notify({ type: "seo-repair-escalated", subject: `Autorreparación: ${v.component} sigue fallando`, body: `La reparación ${v.prUrl ?? ""} no ha bastado y se han agotado los intentos. Abre Claude Code y dile «revisa la incidencia ${v.id.slice(0, 8)} de autorreparación».` });
      log.push(`verificación ${v.id.slice(0, 8)}: el fallo vuelve`);
      continue;
    }
    if (v.verifyUntil && now >= v.verifyUntil) {
      const hb = await prisma.workflowHeartbeat.findUnique({ where: { workflowName: v.component } });
      const ran = hb ? hb.lastRunAt > mergedAt : null;
      await prisma.repairIncident.update({ where: { id: v.id }, data: { status: "resolved" } });
      await deps.notify({
        type: "seo-repair-fixed",
        subject: `Autorreparado: ${v.component}`,
        body: ran === false
          ? `Fusionado ${v.prUrl ?? ""}. Sin fallos nuevos, aunque ${v.component} no se ha vuelto a ejecutar desde entonces: verificación inconclusa.`
          : `Fusionado ${v.prUrl ?? ""} y sin fallos nuevos durante la ventana de verificación.`,
      });
      log.push(`verificación ${v.id.slice(0, 8)}: resuelta`);
    }
  }
  return log;
}
