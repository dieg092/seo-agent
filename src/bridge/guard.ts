// src/bridge/guard.ts
// Guarda externa de Órbita para las tareas SEO automáticas (anexo C.3, O4).
// Órbita la llama al empezar (preflight), tras el trabajo de la IA (scope) y
// antes de fusionar (premerge). Lógica pura: el script decide con lo que lee.
//   0  adelante
//   75 retener: se vuelve a intentar más tarde (freno, interruptor, carril, sin BD)
//   1  bloquear: la tarea no sigue (no es A1, cerrada, fuera de alcance…)
import type { ControlState } from "../brake/brake";
import { checkScope, type DiffFile } from "./scopeCheck";

export const ALLOW = 0;
export const HOLD = 75;
export const BLOCK = 1;

export type GuardStage = "preflight" | "scope" | "premerge";

export interface GuardLink {
  orbitaTaskId: string;
  operation: string | null;
  lane: string;
  autonomy: string;
  contract: unknown;
  closedAt: Date | null;
}

export interface PullRequestInfo {
  title: string;
  labels: string[];
  state: string;
  baseRefName: string;
  files: DiffFile[];
}

export interface GuardInput {
  stage: GuardStage;
  control: ControlState | null;
  link: GuardLink | null;
  /** scope: diff de la rama de la tarea contra origin/main. */
  diff?: DiffFile[];
  /** premerge: el PR tal como lo da la API de GitHub. */
  pr?: PullRequestInfo;
  /** premerge: seo-agent limpio y en origin/main (el código que decide es el revisado). */
  selfIntact?: boolean;
}

export interface GuardDecision {
  code: typeof ALLOW | typeof HOLD | typeof BLOCK;
  reason: string;
}

/** id8 de la tarea de Órbita: el que llevan la rama, el título del PR y el commit `seo(<id8>)`. */
export const taskId8 = (taskId: string) => taskId.replace(/-/g, "").slice(0, 8).toLowerCase();

function publishPolicy(contract: unknown): string | null {
  if (!contract || typeof contract !== "object") return null;
  const p = (contract as Record<string, unknown>).publishPolicy;
  return typeof p === "string" ? p : null;
}

export function guardDecision(input: GuardInput): GuardDecision {
  const { stage, control, link } = input;
  if (!link) return { code: BLOCK, reason: "la tarea no viene del puente SEO" };
  if (link.closedAt) return { code: BLOCK, reason: "la tarea SEO ya está cerrada en seo-agent" };
  if (link.autonomy !== "A1" || publishPolicy(link.contract) !== "auto-merge-if-green") {
    return { code: BLOCK, reason: "la tarea no es A1 con fusión automática" };
  }
  const operation = link.operation ?? "";

  // Cerrado ante el error: sin poder leer el control, nada SEO avanza.
  if (!control) return { code: HOLD, reason: "no se puede leer SeoControl" };
  if (control.masterSwitch !== "on") return { code: HOLD, reason: "interruptor SEO apagado" };
  if (control.brakeState === "tripped") return { code: HOLD, reason: "freno SEO activo" };
  if (control.pausedLanes.includes(link.lane)) return { code: HOLD, reason: `carril ${link.lane} en pausa` };

  if (stage === "scope") {
    const r = checkScope(operation, input.diff ?? []);
    return r.ok ? { code: ALLOW, reason: `alcance OK (${operation})` } : { code: BLOCK, reason: r.errors.join("; ") };
  }

  if (stage === "premerge") {
    if (!input.selfIntact) return { code: HOLD, reason: "seo-agent tiene cambios locales o no está en origin/main" };
    const pr = input.pr;
    if (!pr) return { code: HOLD, reason: "no se pudo leer el PR" };
    if (pr.state !== "OPEN") return { code: BLOCK, reason: `el PR está ${pr.state.toLowerCase()}` };
    if (pr.baseRefName !== "main") return { code: BLOCK, reason: `el PR va contra ${pr.baseRefName}, no contra main` };
    const id8 = taskId8(link.orbitaTaskId);
    if (!pr.title.toLowerCase().startsWith(`seo(${id8}):`)) return { code: BLOCK, reason: `el título del PR no empieza por seo(${id8}):` };
    const ops = pr.labels.filter((l) => l.startsWith("seo-op:"));
    if (!pr.labels.includes("seo-auto") || ops.length !== 1 || ops[0] !== `seo-op:${operation}`) {
      return { code: BLOCK, reason: `el PR no lleva seo-auto y seo-op:${operation} (y solo esa)` };
    }
    const r = checkScope(operation, pr.files);
    return r.ok ? { code: ALLOW, reason: `adelante: PR dentro del alcance de ${operation}` } : { code: BLOCK, reason: r.errors.join("; ") };
  }

  return { code: ALLOW, reason: "adelante" };
}
