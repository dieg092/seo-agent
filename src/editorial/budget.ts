// src/editorial/budget.ts
// Presupuesto de llamadas editoriales al modelo (plan de Codex, paso 4). Comparten cupo de
// suscripción con el trabajador de Órbita, que tiene prioridad:
//   - EDITORIAL_DAILY_BACKGROUND llamadas de fondo al día (calibración, batería, evaluaciones
//     rutinarias) y EDITORIAL_DAILY_GUARD reservadas para las guardas de los PR. Codex propuso 6
//     en total; una sola decisión de la guarda ya necesita 4–6 (dos evaluaciones por versión y
//     desempate), así que la reserva de la guarda es de 6 y el fondo de 14;
//   - el fondo no llama mientras Órbita tiene a Claude trabajando;
//   - tras un límite de cupo, nadie llama hasta la hora de reinicio (quotaUntil).
// La reserva es atómica en la BD. Si la BD falla, no hay permiso.
import { execFileSync } from "node:child_process";
import { prisma } from "../db";
import type { Runner } from "./evaluator";
import { EditorialDeferred, classifyModelError, madridDay, nextMadridMidnight } from "./modelErrors";

export const EDITORIAL_DAILY_BACKGROUND = 14;
export const EDITORIAL_DAILY_GUARD = 6;
const GLOBAL = "global";
const BUSY_WAIT_MS = 30 * 60_000;

export type CallKind = "background" | "guard";

/** ¿Hay un Claude de Órbita trabajando? (el trabajador lo lanza con --permission-mode dontAsk) */
export function orbitaBusy(): boolean {
  try {
    return execFileSync("pgrep", ["-f", "permission-mode dontAsk"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
  } catch {
    return false; // pgrep sale con 1 si no hay ninguno
  }
}

export async function quotaUntil(now: Date): Promise<Date | null> {
  const g = await prisma.editorialBudget.findUnique({ where: { day: GLOBAL } });
  return g?.quotaUntil && g.quotaUntil > now ? g.quotaUntil : null;
}

export async function recordQuota(retryAt: Date): Promise<void> {
  await prisma.editorialBudget.upsert({ where: { day: GLOBAL }, create: { day: GLOBAL, quotaUntil: retryAt }, update: { quotaUntil: retryAt } });
}

/** Reserva una llamada; si no hay, lanza EditorialDeferred con la hora a la que vale la pena reintentar. */
export async function reserveCall(kind: CallKind, now: Date, deps: { busy?: () => boolean } = {}): Promise<void> {
  const q = await quotaUntil(now);
  if (q) throw new EditorialDeferred("quota", q, `cupo del modelo agotado hasta ${q.toISOString()}`);
  if (kind === "background" && (deps.busy ?? orbitaBusy)()) throw new EditorialDeferred("busy", new Date(now.getTime() + BUSY_WAIT_MS), "Órbita está usando el modelo");
  const day = madridDay(now);
  const limit = kind === "background" ? EDITORIAL_DAILY_BACKGROUND : EDITORIAL_DAILY_GUARD;
  await prisma.editorialBudget.upsert({ where: { day }, create: { day }, update: {} });
  const col = kind === "background" ? "background" : "guard";
  const updated = await prisma.editorialBudget.updateMany({ where: { day, [col]: { lt: limit } }, data: { [col]: { increment: 1 } } });
  if (updated.count === 0) throw new EditorialDeferred("budget", nextMadridMidnight(now), `presupuesto editorial de hoy gastado (${limit} llamadas de ${kind === "background" ? "fondo" : "guarda"})`);
}

/** Runner con presupuesto: reserva antes de cada llamada y apunta los límites de cupo. */
export function budgetedRunner(inner: Runner, kind: CallKind, clock: () => Date = () => new Date(), deps: { busy?: () => boolean } = {}): Runner {
  return async (req) => {
    const now = clock();
    await reserveCall(kind, now, deps);
    try {
      return await inner(req);
    } catch (e) {
      const c = classifyModelError(e, now);
      if (c.kind === "quota" && c.retryAt) {
        await recordQuota(c.retryAt);
        throw new EditorialDeferred("quota", c.retryAt, "el modelo devolvió un límite de cupo");
      }
      throw e;
    }
  };
}

export async function budgetToday(now: Date) {
  const row = await prisma.editorialBudget.findUnique({ where: { day: madridDay(now) } });
  return { background: row?.background ?? 0, guard: row?.guard ?? 0, quotaUntil: await quotaUntil(now) };
}
