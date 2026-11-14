// src/bridge/plan.ts
// Decisiones del puente (anexo C.5), sin E/S: qué hallazgos pasan hoy a tarea,
// qué hacer con cada tarea según su estado en Órbita y cuándo caduca.
import { selectByLane, type LaneUsage } from "../prioritization/lanes";
import type { Lane } from "../prioritization/catalog";
import type { LifecycleEvent, OpportunityState } from "../opportunity/lifecycle";
import { getTier } from "../tier1/tierAssignment";
import type { FindingType } from "../prioritization/types";
import { effectiveOperation } from "./contract";

export interface CandidateOpportunity {
  id: string;
  stableKey: string;
  findingType: string;
  page: string | null;
  operation: string | null;
  autonomy: string;
  lane: string;
  priorityScore: number;
  state: string;
  status: string;
}

export interface OpenLink {
  stableKey: string;
  page: string | null;
  operation: string | null;
  lane: string;
  createdAt: Date;
}

/**
 * Tipos que ya tienen su propio camino y no pasan por el puente: los de nivel 1
 * los arregla tier1 solo, y las sugerencias de enlaces van en la tanda semanal
 * de tier2 (un PR por tanda).
 */
export function handledElsewhere(findingType: string): boolean {
  if (findingType === "internal-link-suggestion") return true;
  try {
    return getTier(findingType as FindingType) === 1;
  } catch {
    return false;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Lunes 00:00 UTC de la semana de `d`. */
function startOfUtcWeek(d: Date): number {
  const day = (d.getUTCDay() + 6) % 7;
  return startOfUtcDay(d) - day * DAY_MS;
}

export function laneUsage(links: OpenLink[], now: Date): LaneUsage {
  const today: Partial<Record<Lane, number>> = {};
  const dayStart = startOfUtcDay(now);
  const weekStart = startOfUtcWeek(now);
  let linksThisWeek = 0;
  for (const l of links) {
    const t = l.createdAt.getTime();
    if (t >= dayStart && l.lane !== "urgent" && l.lane !== "links") {
      today[l.lane as Lane] = (today[l.lane as Lane] ?? 0) + 1;
    }
    if (l.lane === "links" && t >= weekStart) linksThisWeek += 1;
  }
  return { today, linksThisWeek };
}

const pageOpKey = (page: string | null, operation: string) => `${page ?? ""}\u0000${operation}`;

/**
 * Hallazgos que pasan hoy a tarea. Solo `open` sin tarea abierta; una tarea
 * por página y operación (contando las abiertas); con los cupos por carril
 * del día (§12.3), contando también lo creado hoy y cerrado después.
 *
 * `recentLinks` = enlaces creados esta semana (abiertos o no), para los cupos.
 */
export function planCreations(
  candidates: CandidateOpportunity[],
  openLinks: OpenLink[],
  recentLinks: OpenLink[],
  now: Date,
): CandidateOpportunity[] {
  const linked = new Set(openLinks.map((l) => l.stableKey));
  const busyPageOps = new Set(openLinks.map((l) => pageOpKey(l.page, effectiveOperation({ operation: l.operation, autonomy: "" }))));

  const eligible: CandidateOpportunity[] = [];
  const seenPageOps = new Set<string>();
  for (const c of [...candidates].sort((a, b) => b.priorityScore - a.priorityScore || a.stableKey.localeCompare(b.stableKey))) {
    if (c.status !== "open" || c.state !== "open") continue;
    if (linked.has(c.stableKey) || handledElsewhere(c.findingType)) continue;
    const key = pageOpKey(c.page, effectiveOperation(c));
    // Sin página no hay riesgo de pisarse: cada hallazgo es una tarea.
    if (c.page && (busyPageOps.has(key) || seenPageOps.has(key))) continue;
    seenPageOps.add(key);
    eligible.push(c);
  }

  const byKey = new Map(eligible.map((c) => [c.stableKey, c]));
  const { selected } = selectByLane(
    eligible.map((c) => ({ stableKey: c.stableKey, lane: c.lane as Lane, priority: c.priorityScore })),
    laneUsage(recentLinks, now),
  );
  return selected.map((s) => byKey.get(s.stableKey)!);
}

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "cancelled" | "missing";

export interface Reconciliation {
  /** Eventos del ciclo de vida a aplicar en orden (los no válidos se ignoran). */
  events: LifecycleEvent["type"][];
  /** Motivo de cierre del enlace, o null si sigue abierto. */
  close: "done" | "cancelled" | "missing" | null;
}

/**
 * Qué hacer cuando la tarea de Órbita está en `status`. En la fase 3 no hay
 * DeployEvent: una tarea hecha se da por aplicada y el hallazgo pasa a
 * verificarse (lo resuelven 3 evaluaciones seguidas sin la condición).
 */
export function reconcile(status: TaskStatus, previous: string): Reconciliation {
  if (status === previous && status !== "done" && status !== "cancelled" && status !== "missing") return { events: [], close: null };
  switch (status) {
    case "todo":
      return { events: [], close: null };
    case "in_progress":
      return { events: ["task-started"], close: null };
    case "blocked":
      return { events: ["task-started", "task-blocked"], close: null };
    case "done":
      return { events: ["task-started", "deployed", "verification-started"], close: "done" };
    case "cancelled":
    case "missing":
      return { events: ["task-cancelled"], close: status };
  }
}

const FINISHED_STATES: ReadonlySet<string> = new Set<OpportunityState>(["resolved", "stale", "dismissed"]);

/**
 * Una tarea sin empezar se cancela si caducó o si su hallazgo ya no hace
 * falta (resuelto, stale o descartado). Solo `todo`: lo que ya empezó sigue.
 */
export function expiryReason(
  link: { taskStatus: string; expiresAt: Date },
  opp: { status: string; state: string } | null,
  now: Date,
): "expired" | "resolved" | null {
  if (link.taskStatus !== "todo") return null;
  if (!opp || opp.status === "resolved" || FINISHED_STATES.has(opp.state)) return "resolved";
  if (now.getTime() > link.expiresAt.getTime()) return "expired";
  return null;
}
