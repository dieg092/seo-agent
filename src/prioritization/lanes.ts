// src/prioritization/lanes.ts
// Carriles y cupos de tareas nuevas (spec maestra §12.3). Función pura: decide
// qué hallazgos pasan hoy a tarea; quien crea las tareas es el puente (fase 3).
import type { Lane } from "./catalog";

/** Cupo diario por carril. `links` es semanal y `urgent` no tiene cupo. */
export const DAILY_LANE_QUOTA: Readonly<Record<Exclude<Lane, "urgent" | "links">, number>> = {
  technical: 4,
  content: 3,
  strategy: 2,
};
export const WEEKLY_LINKS_QUOTA = 1;
/** Total diario de tareas nuevas, sin contar las urgentes. */
export const DAILY_TOTAL_QUOTA = 10;

export interface LaneCandidate {
  stableKey: string;
  lane: Lane;
  priority: number;
}

export interface LaneUsage {
  /** Tareas nuevas creadas hoy por carril (sin contar urgent). */
  today: Partial<Record<Lane, number>>;
  /** Tareas nuevas del carril links en la semana en curso. */
  linksThisWeek: number;
}

export interface LaneSelection {
  selected: LaneCandidate[];
  /** Los que no entran hoy por cupo, en orden de prioridad. */
  deferred: LaneCandidate[];
}

function byPriorityDesc(a: LaneCandidate, b: LaneCandidate): number {
  return b.priority - a.priority || a.stableKey.localeCompare(b.stableKey);
}

/**
 * Elige los hallazgos que pasan hoy a tarea. Cada carril se llena con sus
 * mejores candidatos hasta su cupo; el cupo que no se usa **no** pasa a otro
 * carril. Lo urgente entra siempre y no cuenta para el total de 10.
 */
export function selectByLane(candidates: LaneCandidate[], usage: LaneUsage = { today: {}, linksThisWeek: 0 }): LaneSelection {
  const sorted = [...candidates].sort(byPriorityDesc);
  const used: Record<Lane, number> = {
    urgent: 0,
    technical: usage.today.technical ?? 0,
    content: usage.today.content ?? 0,
    links: usage.today.links ?? 0,
    strategy: usage.today.strategy ?? 0,
  };
  let total = used.technical + used.content + used.links + used.strategy;
  let linksThisWeek = usage.linksThisWeek;

  const selected: LaneCandidate[] = [];
  const deferred: LaneCandidate[] = [];

  for (const candidate of sorted) {
    if (candidate.lane === "urgent") {
      selected.push(candidate);
      continue;
    }
    const laneHasRoom =
      candidate.lane === "links" ? linksThisWeek < WEEKLY_LINKS_QUOTA : used[candidate.lane] < DAILY_LANE_QUOTA[candidate.lane];
    if (!laneHasRoom || total >= DAILY_TOTAL_QUOTA) {
      deferred.push(candidate);
      continue;
    }
    selected.push(candidate);
    used[candidate.lane] += 1;
    total += 1;
    if (candidate.lane === "links") linksThisWeek += 1;
  }

  return { selected, deferred };
}
