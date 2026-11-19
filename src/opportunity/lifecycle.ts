// src/opportunity/lifecycle.ts
// Ciclo de vida de un hallazgo (spec maestra §6 y Anexo B.1). Función pura: no
// toca la BD. Quien la usa guarda el resultado en las columnas de Opportunity.
//
// Decisiones donde el diagrama de §6 no dice nada (documentadas en docs/lifecycle.md):
// - `blocked` sale con `task-started` (se desbloquea) o `task-cancelled`.
// - `task-cancelled` lleva a `dismissed` desde open, queued, in_progress y blocked
//   (§7: «cancelled → el hallazgo pasa a dismissed»).
// - Un `detected` que desaparece vuelve a 0 confirmaciones y sigue en `detected`.
// - `stale` es terminal.

export const OPPORTUNITY_STATES = [
  "detected",
  "open",
  "queued",
  "in_progress",
  "applied",
  "verifying",
  "resolved",
  "regression",
  "blocked",
  "dismissed",
  "stale",
] as const;

export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

/** Evaluaciones consecutivas con la condición presente para abrir un hallazgo no crítico. */
export const CONFIRMATIONS_TO_OPEN = 2;
/** Evaluaciones consecutivas sin la condición para darlo por resuelto. */
export const ABSENCES_TO_RESOLVE = 3;
/** Reaperturas dentro de la ventana que lo pasan a `stale`. */
export const OSCILLATIONS_TO_STALE = 3;
export const OSCILLATION_WINDOW_DAYS = 60;
/** Días abierto (con la tarea cerrada) o verificando sin resolverse que lo pasan a `stale`. */
export const STALE_AFTER_DAYS = 60;
/** Días tras los que un `dismissed` que sigue presente se reabre. */
export const DISMISSED_REOPEN_DAYS = 90;
/** Un `dismissed` se reabre si `value × severityW` llega a este múltiplo del de entonces. */
export const DISMISSED_WORSEN_FACTOR = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Lifecycle {
  state: OpportunityState;
  stateChangedAt: Date;
  /** Evaluaciones consecutivas con la condición presente. */
  confirmations: number;
  /** Evaluaciones consecutivas con la condición ausente. */
  absences: number;
  /** Reaperturas dentro de la ventana que empezó en `oscillationsSince`. */
  oscillations: number;
  oscillationsSince: Date | null;
  /** `value × severityW` en el momento de descartarlo. */
  dismissedValue: number | null;
  staleAt: Date | null;
}

export type LifecycleEvent =
  /** La evaluación encontró la condición. `value` = value × severityW actual. */
  | { type: "observed"; critical: boolean; value: number }
  /** La evaluación no encontró la condición. */
  | { type: "absent" }
  /** Paso del tiempo. `taskClosed`: la tarea de Órbita del hallazgo está cerrada. */
  | { type: "tick"; taskClosed: boolean }
  /** El puente creó la tarea en Órbita (también la de reversión de una regresión). */
  | { type: "task-created" }
  /** La tarea pasa a in_progress (o se desbloquea). */
  | { type: "task-started" }
  | { type: "task-blocked" }
  /** El cambio de la tarea está desplegado. */
  | { type: "deployed" }
  /** Empieza la sonda posterior al despliegue. */
  | { type: "verification-started" }
  /** Error técnico atribuible al cambio. */
  | { type: "regression-detected" }
  /** El fundador cancela la tarea. `value` = value × severityW actual. */
  | { type: "task-cancelled"; value: number };

export type LifecycleEventType = LifecycleEvent["type"];

/** Eventos de evaluación: llegan en cualquier estado y, si no aplican, no cambian nada. */
const EVALUATION_EVENTS: ReadonlySet<LifecycleEventType> = new Set(["observed", "absent", "tick"]);

/** Transiciones válidas por eventos de la tarea (no de evaluación). */
const TASK_TRANSITIONS: Readonly<Record<Exclude<LifecycleEventType, "observed" | "absent" | "tick">, Partial<Record<OpportunityState, OpportunityState>>>> = {
  "task-created": { open: "queued", regression: "queued" },
  "task-started": { queued: "in_progress", blocked: "in_progress" },
  "task-blocked": { in_progress: "blocked" },
  deployed: { in_progress: "applied" },
  "verification-started": { applied: "verifying" },
  "regression-detected": { verifying: "regression" },
  "task-cancelled": { open: "dismissed", queued: "dismissed", in_progress: "dismissed", blocked: "dismissed" },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: OpportunityState,
    public readonly event: LifecycleEventType,
  ) {
    super(`Transición no válida: ${event} desde ${from}`);
    this.name = "InvalidTransitionError";
  }
}

export function isOpportunityState(value: string): value is OpportunityState {
  return (OPPORTUNITY_STATES as readonly string[]).includes(value);
}

/** Si un evento de tarea es válido desde ese estado. Los de evaluación siempre lo son. */
export function canTransition(from: OpportunityState, event: LifecycleEventType): boolean {
  if (EVALUATION_EVENTS.has(event)) return true;
  const table = TASK_TRANSITIONS[event as keyof typeof TASK_TRANSITIONS];
  return table[from] !== undefined;
}

/** Estado inicial de un hallazgo que se ve por primera vez. */
export function initialLifecycle(critical: boolean, now: Date): Lifecycle {
  return {
    state: critical ? "open" : "detected",
    stateChangedAt: now,
    confirmations: 1,
    absences: 0,
    oscillations: 0,
    oscillationsSince: null,
    dismissedValue: null,
    staleAt: null,
  };
}

function moveTo(current: Lifecycle, state: OpportunityState, now: Date, extra: Partial<Lifecycle> = {}): Lifecycle {
  return { ...current, ...extra, state, stateChangedAt: now };
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / DAY_MS;
}

function onObserved(current: Lifecycle, event: { critical: boolean; value: number }, now: Date): Lifecycle {
  const confirmations = current.confirmations + 1;
  const seen = { ...current, confirmations, absences: 0 };

  switch (current.state) {
    case "detected": {
      const needed = event.critical ? 1 : CONFIRMATIONS_TO_OPEN;
      return confirmations >= needed ? moveTo(seen, "open", now) : seen;
    }
    case "resolved": {
      // Reaparece: cuenta como oscilación dentro de la ventana de 60 días.
      const windowExpired =
        current.oscillationsSince === null || daysBetween(current.oscillationsSince, now) > OSCILLATION_WINDOW_DAYS;
      const oscillations = windowExpired ? 1 : current.oscillations + 1;
      const oscillationsSince = windowExpired ? now : current.oscillationsSince;
      if (oscillations >= OSCILLATIONS_TO_STALE) {
        return moveTo(seen, "stale", now, { oscillations, oscillationsSince, staleAt: now });
      }
      return moveTo(seen, "open", now, { oscillations, oscillationsSince });
    }
    case "dismissed": {
      const worsened =
        current.dismissedValue !== null &&
        current.dismissedValue > 0 &&
        event.value >= DISMISSED_WORSEN_FACTOR * current.dismissedValue;
      const expired = daysBetween(current.stateChangedAt, now) >= DISMISSED_REOPEN_DAYS;
      return worsened || expired ? moveTo(seen, "open", now, { dismissedValue: null }) : seen;
    }
    default:
      return seen;
  }
}

function onAbsent(current: Lifecycle, now: Date): Lifecycle {
  switch (current.state) {
    case "detected": {
      // No llegó a confirmarse: vuelve a empezar la cuenta y, si sigue sin
      // aparecer, se cierra (si no, se quedaba «detectado» para siempre).
      const absences = current.absences + 1;
      const gone = { ...current, confirmations: 0, absences };
      return absences >= ABSENCES_TO_RESOLVE ? moveTo(gone, "resolved", now) : gone;
    }
    case "open":
    case "verifying": {
      const absences = current.absences + 1;
      const gone = { ...current, absences, confirmations: 0 };
      return absences >= ABSENCES_TO_RESOLVE ? moveTo(gone, "resolved", now) : gone;
    }
    default:
      return { ...current, confirmations: 0, absences: current.absences + 1 };
  }
}

function onTick(current: Lifecycle, taskClosed: boolean, now: Date): Lifecycle {
  const age = daysBetween(current.stateChangedAt, now);
  if (age < STALE_AFTER_DAYS) return current;
  // verifying implica tarea cerrada (cambio desplegado); open solo si su tarea ya se cerró.
  if (current.state === "verifying" || (current.state === "open" && taskClosed)) {
    return moveTo(current, "stale", now, { staleAt: now });
  }
  return current;
}

/**
 * Aplica un evento al ciclo de vida. Los eventos de evaluación (observed, absent,
 * tick) nunca fallan; los de la tarea lanzan InvalidTransitionError si no son
 * válidos desde el estado actual.
 */
export function transition(current: Lifecycle, event: LifecycleEvent, now: Date): Lifecycle {
  switch (event.type) {
    case "observed":
      return current.state === "stale" ? current : onObserved(current, event, now);
    case "absent":
      return current.state === "stale" ? current : onAbsent(current, now);
    case "tick":
      return onTick(current, event.taskClosed, now);
    default: {
      const target = TASK_TRANSITIONS[event.type][current.state];
      if (target === undefined) throw new InvalidTransitionError(current.state, event.type);
      if (event.type === "task-cancelled") {
        return moveTo(current, target, now, { dismissedValue: event.value });
      }
      // Al entrar en verificación se empieza a contar ausencias desde cero.
      if (event.type === "verification-started") {
        return moveTo(current, target, now, { absences: 0 });
      }
      return moveTo(current, target, now);
    }
  }
}
