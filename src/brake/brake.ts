// src/brake/brake.ts
// Freno automático (§14). Lógica pura: recibe los datos y decide si salta y
// qué carriles pausa. La carga está en loadBrake.ts; el estado, en SeoControl.
// La anomalía de despliegue (rollbacks del smoke test) entra en la fase 4 con
// el job seo_merge: todavía no hay despliegues seo-auto que contar.

export interface BrakeInputs {
  /** URLs públicas del sitemap indexadas (última inspección) ahora y hace 7 días. */
  indexedNow: number;
  indexed7dAgo: number;
  /** PrivateIncident sin resolver. */
  openPrivateIncidents: number;
  /** Estados de las últimas tareas SEO cerradas o bloqueadas, la más reciente primero. */
  recentTaskOutcomes: string[];
  /** SeoTaskLink creados en las últimas 24 h. */
  tasksCreated24h: number;
  /** Impresiones web de los últimos 7 días cerrados y de los 7 anteriores. */
  impressions7d: number;
  impressionsPrior7d: number;
  /** Días seguidos (los más recientes) sin datos de GSC o de inspección. */
  criticalCollectorFailDays: number;
}

export interface BrakeDecision {
  trip: boolean;
  reasons: string[];
  /** Carriles a pausar sin saltar el freno (calidad de datos). */
  pauseLanes: string[];
}

export const INDEXATION_DROP = 0.1;
export const INDEXATION_MIN_URLS = 3;
export const VISIBILITY_DROP = 0.4;
export const VISIBILITY_MIN_BASE = 500;
export const MAX_TASKS_24H = 15;
export const FAILED_IN_A_ROW = 3;

export function evaluateBrake(i: BrakeInputs): BrakeDecision {
  const reasons: string[] = [];
  const lost = i.indexed7dAgo - i.indexedNow;
  if (lost >= INDEXATION_MIN_URLS && i.indexed7dAgo > 0 && lost / i.indexed7dAgo >= INDEXATION_DROP) {
    reasons.push(`regresión de indexación: ${i.indexed7dAgo} → ${i.indexedNow} URLs indexadas en 7 días`);
  }
  if (i.openPrivateIncidents > 0) reasons.push(`exposición privada: ${i.openPrivateIncidents} incidente(s) sin resolver`);
  const lastN = i.recentTaskOutcomes.slice(0, FAILED_IN_A_ROW);
  if (lastN.length === FAILED_IN_A_ROW && lastN.every((s) => s === "blocked" || s === "failed")) {
    reasons.push(`errores repetidos: las últimas ${FAILED_IN_A_ROW} tareas SEO fallaron o se bloquearon`);
  }
  if (i.tasksCreated24h > MAX_TASKS_24H) reasons.push(`comportamiento anómalo: ${i.tasksCreated24h} tareas SEO creadas en 24 h`);
  if (i.impressionsPrior7d >= VISIBILITY_MIN_BASE && i.impressions7d <= i.impressionsPrior7d * (1 - VISIBILITY_DROP)) {
    reasons.push(`caída de visibilidad: ${i.impressionsPrior7d} → ${i.impressions7d} impresiones web en 7 días`);
  }
  const pauseLanes = i.criticalCollectorFailDays >= 2 ? ["content", "links"] : [];
  return { trip: reasons.length > 0, reasons, pauseLanes };
}

export interface ControlState {
  masterSwitch: string;
  pausedLanes: string[];
  brakeState: string;
}

/**
 * ¿Puede el puente crear una tarea de este carril y autonomía? Con el freno o
 * el interruptor, solo lo urgente A3 y lo que no escribe código (investigación,
 * manual). Un carril en pausa no crea nada, salvo `urgent`.
 */
export function mayCreate(control: ControlState | null, lane: string, operation: string): boolean {
  // Sin poder leer el control, se cierra todo lo que no sea urgente (§14).
  if (!control) return lane === "urgent";
  const readOnly = operation === "investigation" || operation === "manual" || operation === "proposal";
  if (control.masterSwitch !== "on" || control.brakeState === "tripped") return lane === "urgent" || readOnly;
  if (control.pausedLanes.includes(lane) && lane !== "urgent") return false;
  return true;
}

// ─── seo-brake-gate (CI de wedding-invite-2) ────────────────────────────────

/** Marcador de los commits SEO: asunto `seo(<id8>): …`. */
export const SEO_COMMIT = /^seo\(([0-9a-z-]{4,40})\)/i;

export function seoChangeIds(subjects: string[]): string[] {
  return subjects.map((s) => SEO_COMMIT.exec(s.trim())?.[1]).filter((id): id is string => Boolean(id));
}

export type GateDecision = { allow: true; seoChangeIds: string[] } | { allow: false; reason: string; seoChangeIds: string[] };

/**
 * Decisión del gate (anexo C.4). En un PR (`mode: pr`) falla con el freno o el
 * interruptor activos. En el push a main solo actúa si el rango tiene commits
 * `seo(…)`: nunca bloquea un rango sin cambios SEO. Sin poder leer el control,
 * cierra (lo SEO no se despliega).
 */
export function gateDecision(mode: "pr" | "push", subjects: string[], control: ControlState | null): GateDecision {
  const ids = seoChangeIds(subjects);
  if (mode === "push" && ids.length === 0) return { allow: true, seoChangeIds: [] };
  if (!control) return { allow: false, reason: "no se puede leer SeoControl", seoChangeIds: ids };
  if (control.masterSwitch !== "on") return { allow: false, reason: "interruptor SEO apagado", seoChangeIds: ids };
  if (control.brakeState === "tripped") return { allow: false, reason: "freno SEO activo", seoChangeIds: ids };
  return { allow: true, seoChangeIds: ids };
}

// ─── revert-change determinista (§15.3) ─────────────────────────────────────

/**
 * ¿Es `revertDiff` exactamente el inverso de `commitDiff`? Compara los diffs
 * unificados línea a línea: cada `+` del commit tiene que ser un `-` del
 * revert y al revés, en los mismos archivos. Ignora cabeceras de índice y
 * números de línea de los hunks.
 */
export function isExactInverse(commitDiff: string, revertDiff: string): boolean {
  const norm = (diff: string, invert: boolean) => {
    const out: string[] = [];
    let file = "";
    for (const line of diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        file = line.replace(/^diff --git a\/(\S+) b\/\S+$/, "$1");
        continue;
      }
      if (line.startsWith("index ") || line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
      if (line.startsWith("+") || line.startsWith("-")) {
        const sign = line[0] === "+" ? (invert ? "-" : "+") : invert ? "+" : "-";
        out.push(`${file}\u0000${sign}${line.slice(1)}`);
      }
    }
    return out.sort();
  };
  const a = norm(commitDiff, true);
  const b = norm(revertDiff, false);
  return a.length > 0 && a.length === b.length && a.every((l, i) => l === b[i]);
}
