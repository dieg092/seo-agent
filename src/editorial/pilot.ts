// src/editorial/pilot.ts
// Piloto editorial (plan de Codex, paso 6). La correlación nota–GSC entre artículos distintos no
// dice si las mejoras aprobadas funcionan; el piloto lo mide cambio a cambio con el registro de
// cambios (SeoChange). Mientras tanto, la exposición se limita:
//   - como mucho PILOT_MAX_OPEN pilotos abiertos y PILOT_SPACING_DAYS días entre reservas;
//   - ninguna página con un piloto abierto o un cambio SEO reciente (ventanas limpias);
//   - un negativo confirmado pausa el piloto hasta que su reversión esté desplegada y la batería
//     de defectos vuelva a pasar después;
//   - a los PILOT_MAX_DAYS días sin datos suficientes, el experimento se cierra como inconcluso y
//     deja la plaza: la falta de tráfico no bloquea la cola para siempre.
// Estados: reserved → observing → positive | negative | neutral | inconclusive | not-evaluable;
// una reserva sin despliegue en PILOT_RESERVE_HOURS se libera (released) y puede volver a pedirse.
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import { batteryKey } from "./battery";

export const PILOT_MAX_OPEN = 2;
export const PILOT_SPACING_DAYS = 14;
export const PILOT_RESERVE_HOURS = 24;
export const PILOT_MAX_DAYS = 90;
export const PILOT_REPORT_DAYS = 180;
export const PILOT_MIN_EVALUABLE = 10;
/** Sin otro cambio SEO desplegado en la misma página en estos días (ventana previa + posterior). */
export const PAGE_QUIET_DAYS = 56;
const DAY = 24 * 3600_000;
const OPEN_STATES = ["reserved", "observing"];
const PAUSING_CHANGE = ["negative-unconfirmed", "negative-confirmed", "revert-open", "revert-merged", "revert-failed"];

export type Reservation = { ok: true; note: string } | { ok: false; reason: string };

/** ¿Hay una mejora de artículo pendiente de revertir o una reversión sin batería posterior? */
async function pauseReason(): Promise<string | null> {
  const pending = await prisma.seoChange.findFirst({ where: { operation: "content-improve", status: { in: PAUSING_CHANGE } } });
  if (pending) return `piloto en pausa: el cambio ${pending.changeId8} tiene un negativo sin cerrar (${pending.status})`;
  const lastRevert = await prisma.seoChange.findFirst({ where: { operation: "content-improve", status: "revert-verified" }, orderBy: { revertVerifiedAt: "desc" } });
  if (lastRevert?.revertVerifiedAt) {
    const battery = await prisma.editorialBattery.findFirst({ where: { passed: true, createdAt: { gt: lastRevert.revertVerifiedAt } } });
    if (!battery) return `piloto en pausa: falta repetir la batería de defectos tras revertir ${lastRevert.changeId8}`;
  }
  // Un informe «perjudicial» pausa hasta que cambie la configuración (rúbrica, prompt, modelo o
  // reglas) y la batería nueva pase.
  const report = await prisma.alert.findFirst({ where: { type: "editorial-pilot-report" }, orderBy: { createdAt: "desc" } });
  if (report?.subject.includes("perjudicial")) {
    const before = await prisma.editorialBattery.findFirst({ where: { createdAt: { lte: report.createdAt } }, orderBy: { createdAt: "desc" } });
    const current = batteryKey();
    const fresh = await prisma.editorialBattery.findFirst({ where: { passed: true, configKey: current, createdAt: { gt: report.createdAt } } });
    if (!fresh || before?.configKey === current) return "piloto en pausa: el último informe fue perjudicial y la configuración editorial no ha cambiado";
  }
  return null;
}

/** Plaza del piloto para la tarea; idempotente (la misma tarea reutiliza su reserva). */
export async function reservePilot(task: { orbitaTaskId: string; page: string }, now: Date): Promise<Reservation> {
  const pause = await pauseReason();
  if (pause) return { ok: false, reason: pause };
  try {
    return await reserveTx(task, now);
  } catch {
    // dos guardas a la vez: la transacción serializable deja pasar a una; la otra se reintenta luego
    return { ok: false, reason: "otra reserva del piloto en curso; se reintenta" };
  }
}

function reserveTx(task: { orbitaTaskId: string; page: string }, now: Date): Promise<Reservation> {
  return prisma.$transaction(
    async (tx) => {
      const mine = await tx.editorialPilot.findUnique({ where: { orbitaTaskId: task.orbitaTaskId } });
      if (mine && OPEN_STATES.includes(mine.state)) return { ok: true, note: "plaza del piloto ya reservada" } as const;
      if (mine && mine.state !== "released") return { ok: false, reason: `esta tarea ya pasó por el piloto (${mine.state})` } as const;
      const open = await tx.editorialPilot.findMany({ where: { state: { in: OPEN_STATES } } });
      if (open.length >= PILOT_MAX_OPEN) return { ok: false, reason: `piloto lleno (${open.length} de ${PILOT_MAX_OPEN} en observación)` } as const;
      if (open.some((p) => p.page === task.page)) return { ok: false, reason: "la página ya tiene un piloto en observación" } as const;
      const last = await tx.editorialPilot.findFirst({ where: { state: { not: "released" } }, orderBy: { reservedAt: "desc" } });
      if (last && now.getTime() - last.reservedAt.getTime() < PILOT_SPACING_DAYS * DAY) {
        const next = new Date(last.reservedAt.getTime() + PILOT_SPACING_DAYS * DAY);
        return { ok: false, reason: `el siguiente piloto puede salir a partir del ${next.toISOString().slice(0, 10)}` } as const;
      }
      const recent = await tx.seoChange.count({ where: { page: task.page, deployedAt: { gte: new Date(now.getTime() - PAGE_QUIET_DAYS * DAY) } } });
      if (recent > 0) return { ok: false, reason: `la página tuvo otro cambio SEO en los últimos ${PAGE_QUIET_DAYS} días (la medición no sería limpia)` } as const;
      const data = { page: task.page, state: "reserved", reservedAt: now, deployedAt: null, closedAt: null, outcome: null };
      if (mine) await tx.editorialPilot.update({ where: { id: mine.id }, data });
      else await tx.editorialPilot.create({ data: { ...data, orbitaTaskId: task.orbitaTaskId } });
      return { ok: true, note: "plaza del piloto reservada" } as const;
    },
    { isolationLevel: "Serializable" },
  );
}

/** ¿Merece la pena crear ahora una tarea automática de mejora de artículo? */
export async function pilotHasRoom(now: Date): Promise<boolean> {
  if (await pauseReason()) return false;
  const open = await prisma.editorialPilot.count({ where: { state: { in: OPEN_STATES } } });
  if (open >= PILOT_MAX_OPEN) return false;
  const last = await prisma.editorialPilot.findFirst({ where: { state: { not: "released" } }, orderBy: { reservedAt: "desc" } });
  return !last || now.getTime() - last.reservedAt.getTime() >= PILOT_SPACING_DAYS * DAY;
}

const CLOSE_FROM_CHANGE: Record<string, (outcome: string | null) => string> = {
  measured: (o) => (o === "positive" ? "positive" : o === "negative" ? "negative" : o === "neutral" ? "neutral" : "inconclusive"),
  "not-evaluable": () => "not-evaluable",
  "negative-confirmed": () => "negative",
  "revert-open": () => "negative",
  "revert-merged": () => "negative",
  "revert-verified": () => "negative",
  "revert-failed": () => "negative",
};

/** Una pasada: despliegues, resultados, reservas abandonadas y experimentos caducados. */
export async function advancePilots(now: Date): Promise<string[]> {
  const notes: string[] = [];
  for (const p of await prisma.editorialPilot.findMany({ where: { state: { in: OPEN_STATES } } })) {
    const change = await prisma.seoChange.findUnique({ where: { orbitaTaskId: p.orbitaTaskId } });
    if (p.state === "reserved") {
      if (change?.deployedAt) {
        await prisma.editorialPilot.update({ where: { id: p.id }, data: { state: "observing", deployedAt: change.deployedAt } });
        notes.push(`piloto: ${p.orbitaTaskId.slice(0, 8)} desplegado, en observación`);
      } else if (!change && now.getTime() - p.reservedAt.getTime() > PILOT_RESERVE_HOURS * 3600_000) {
        await prisma.editorialPilot.update({ where: { id: p.id }, data: { state: "released", closedAt: now } });
        notes.push(`piloto: reserva de ${p.orbitaTaskId.slice(0, 8)} liberada (sin fusionar en ${PILOT_RESERVE_HOURS} h)`);
      }
      continue;
    }
    const close = change && CLOSE_FROM_CHANGE[change.status];
    if (close) {
      const state = close(change.outcome);
      await prisma.editorialPilot.update({ where: { id: p.id }, data: { state, outcome: change.outcome, closedAt: now, detail: (change.outcomeDetail ?? undefined) as object | undefined } });
      notes.push(`piloto: ${p.orbitaTaskId.slice(0, 8)} cerrado (${state})`);
    } else if (p.deployedAt && now.getTime() - p.deployedAt.getTime() > PILOT_MAX_DAYS * DAY) {
      await prisma.editorialPilot.update({ where: { id: p.id }, data: { state: "inconclusive", closedAt: now, outcome: "inconclusive" } });
      notes.push(`piloto: ${p.orbitaTaskId.slice(0, 8)} inconcluso a los ${PILOT_MAX_DAYS} días, plaza libre`);
    }
  }
  return notes;
}

export type PilotVerdict = "favorable" | "perjudicial" | "insuficiente";

export function pilotVerdict(closed: { state: string }[], pendingReverts: number): { verdict: PilotVerdict; detail: string } {
  const count = (s: string) => closed.filter((c) => c.state === s).length;
  const pos = count("positive");
  const neg = count("negative");
  const neu = count("neutral");
  const evaluable = pos + neg + neu;
  const detail = `${evaluable} evaluables (${pos} positivos, ${neu} neutros, ${neg} negativos), ${count("inconclusive")} inconclusos, ${count("not-evaluable")} no evaluables`;
  if (neg > pos) return { verdict: "perjudicial", detail };
  // Sin grupo de control: incluso con volumen, solo «favorable» si no hay ningún negativo pendiente
  // y los positivos superan claramente a los negativos. No es una prueba causal.
  if (evaluable >= PILOT_MIN_EVALUABLE && pendingReverts === 0 && pos >= 2 * Math.max(1, neg) && pos > neu) return { verdict: "favorable", detail };
  return { verdict: "insuficiente", detail };
}

/** Informe automático cada PILOT_REPORT_DAYS desde el primer piloto desplegado. */
export async function pilotReport(now: Date, alert: typeof recordAlert = recordAlert): Promise<string[]> {
  const first = await prisma.editorialPilot.findFirst({ where: { deployedAt: { not: null } }, orderBy: { deployedAt: "asc" } });
  if (!first?.deployedAt || now.getTime() - first.deployedAt.getTime() < PILOT_REPORT_DAYS * DAY) return [];
  const last = await prisma.alert.findFirst({ where: { type: "editorial-pilot-report" }, orderBy: { createdAt: "desc" } });
  if (last && now.getTime() - last.createdAt.getTime() < PILOT_REPORT_DAYS * DAY) return [];
  const closed = await prisma.editorialPilot.findMany({ where: { closedAt: { not: null }, state: { not: "released" } } });
  const pendingReverts = await prisma.seoChange.count({ where: { operation: "content-improve", status: { in: PAUSING_CHANGE } } });
  const { verdict, detail } = pilotVerdict(closed, pendingReverts);
  const what =
    verdict === "favorable"
      ? "las mejoras aprobadas por la IA editorial tienden a funcionar (sin grupo de control: no es una prueba causal)"
      : verdict === "perjudicial"
        ? "las mejoras aprobadas empeoran más páginas de las que mejoran: el piloto se queda en pausa hasta revisar la rúbrica"
        : "todavía no hay datos suficientes; el piloto sigue con los mismos límites";
  await alert({ type: "editorial-pilot-report", subject: `Piloto editorial: evidencia ${verdict}`, body: `${detail}. Conclusión: ${what}.` });
  return [`piloto: informe ${verdict} (${detail})`];
}
