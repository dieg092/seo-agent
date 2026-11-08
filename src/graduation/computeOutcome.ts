// src/graduation/computeOutcome.ts
// Resultado de un cambio (spec maestra §15.2). Sustituye al cálculo anterior,
// que daba «positive» con solo que los clics no bajaran un 15%.

export type Outcome = "positive" | "negative" | "inconclusive" | "pending" | "not_evaluable";

/** Indicador que se compara entre las dos ventanas. */
export type OutcomeMetric = "clicks" | "impressions" | "position" | "ctr";

/**
 * low: hasta que el sitio pase de 1.000 clics no-marca al mes 2 meses seguidos
 * (R-B5): por página, sin control, y solo veredicto con cambios de ±50%.
 * high: diferencia en diferencias frente al grupo de control y banda de ruido.
 */
export type VolumeMode = "low" | "high";

export interface WindowMetrics {
  clicks: number;
  impressions: number;
  /** Posición media ponderada por impresiones; necesaria si metric = position. */
  position?: number | null;
}

export interface ControlGroup {
  /** Páginas de control (misma intent y plantilla, sin cambios en la ventana). */
  pages: number;
  /** Variación relativa del control en la misma orientación que la de la página (+ = mejor). */
  delta: number;
  /** Percentil 80 de |variación| de las páginas de control en 6 meses. */
  noiseBand: number;
}

export interface OutcomeInput {
  deployedAt: Date;
  now: Date;
  before: WindowMetrics;
  after: WindowMetrics;
  metric: OutcomeMetric;
  mode: VolumeMode;
  /** Otro cambio en la misma página dentro de la ventana. */
  simultaneousChange?: boolean;
  /** Solo en modo high. */
  control?: ControlGroup | null;
}

export interface OutcomeResult {
  outcome: Outcome;
  /** Variación relativa de la página (+ = mejor), o null si no se llegó a calcular. */
  change: number | null;
  /** Variación del control (solo en modo high). */
  controlDelta: number | null;
  /** Efecto estimado: change − controlDelta en modo high, change en modo low. */
  effect: number | null;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const WINDOW_DAYS = 28;
/** Retraso de GSC hasta tener días finales. */
export const GSC_LAG_DAYS = 3;

// Con pocos clics un -15% es ruido (8 → 2 en tendencias-bodas-2027 abrió una
// reversión del PR #99 en oct-2026 cuando la posición no se había movido).
// Por debajo de este volumen en la ventana previa no hay veredicto.
export const MIN_BASELINE_CLICKS = 20;
/** Impresiones mínimas por ventana para juzgar el CTR (y cualquier cosa en modo low). */
export const MIN_IMPRESSIONS_CTR = 300;
/** Impresiones mínimas por ventana para juzgar la posición, las impresiones o los clics en modo high. */
export const MIN_IMPRESSIONS_POSITION = 100;
/** Umbral grueso del modo low (R-B5). */
export const LOW_VOLUME_THRESHOLD = 0.5;
export const MIN_CONTROL_PAGES = 3;

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Ventanas de medición: la de después empieza el día siguiente al despliegue
 * más los 3 días de retraso de GSC y dura 28 días; la de antes son los 28 días
 * que terminan el día del despliegue (incluido). Intervalos [start, end).
 */
export function measurementWindows(deployedAt: Date): {
  before: { start: Date; end: Date };
  after: { start: Date; end: Date };
} {
  const deployDay = startOfUtcDay(deployedAt);
  const beforeEnd = new Date(deployDay.getTime() + DAY_MS);
  const afterStart = new Date(deployDay.getTime() + (1 + GSC_LAG_DAYS) * DAY_MS);
  return {
    before: { start: new Date(beforeEnd.getTime() - WINDOW_DAYS * DAY_MS), end: beforeEnd },
    after: { start: afterStart, end: new Date(afterStart.getTime() + WINDOW_DAYS * DAY_MS) },
  };
}

/** Cuándo deja de ser `pending`: terminada la ventana de después y su retraso de GSC. */
export function evaluableFrom(deployedAt: Date): Date {
  return new Date(measurementWindows(deployedAt).after.end.getTime() + GSC_LAG_DAYS * DAY_MS);
}

function metricValue(metric: OutcomeMetric, w: WindowMetrics): number | null {
  switch (metric) {
    case "clicks":
      return w.clicks;
    case "impressions":
      return w.impressions;
    case "ctr":
      return w.impressions > 0 ? w.clicks / w.impressions : null;
    case "position":
      return w.position ?? null;
  }
}

/** Variación relativa orientada a «+ = mejor» (en posición, bajar es mejorar). */
function relativeChange(metric: OutcomeMetric, before: number, after: number): number | null {
  if (before <= 0) return null;
  return metric === "position" ? (before - after) / before : (after - before) / before;
}

function minImpressions(metric: OutcomeMetric, mode: VolumeMode): number {
  if (mode === "low" || metric === "ctr") return MIN_IMPRESSIONS_CTR;
  return MIN_IMPRESSIONS_POSITION;
}

function result(outcome: Outcome, reason: string, extra: Partial<OutcomeResult> = {}): OutcomeResult {
  return { outcome, change: null, controlDelta: null, effect: null, reason, ...extra };
}

export function computeOutcome(input: OutcomeInput): OutcomeResult {
  const { before, after, metric, mode } = input;

  if (input.now.getTime() < evaluableFrom(input.deployedAt).getTime()) {
    return result("pending", "La ventana de 28 días y el retraso de GSC no han terminado");
  }
  if (input.simultaneousChange) {
    return result("not_evaluable", "Hay otro cambio en la misma página dentro de la ventana");
  }
  const control = mode === "high" ? input.control ?? null : null;
  if (mode === "high" && (!control || control.pages < MIN_CONTROL_PAGES)) {
    return result("not_evaluable", `Menos de ${MIN_CONTROL_PAGES} páginas de control`);
  }
  if (before.clicks < MIN_BASELINE_CLICKS) {
    return result("inconclusive", `Menos de ${MIN_BASELINE_CLICKS} clics en la ventana previa`);
  }
  const minImpr = minImpressions(metric, mode);
  if (before.impressions < minImpr || after.impressions < minImpr) {
    return result("inconclusive", `Menos de ${minImpr} impresiones en alguna ventana`);
  }

  const b = metricValue(metric, before);
  const a = metricValue(metric, after);
  const change = b === null || a === null ? null : relativeChange(metric, b, a);
  if (change === null) {
    return result("inconclusive", `Sin valor de ${metric} comparable en las dos ventanas`);
  }

  if (mode === "low") {
    // Nunca «positive» por no haber bajado: hace falta superar el umbral hacia arriba.
    if (change > LOW_VOLUME_THRESHOLD) return result("positive", "Mejora de más del 50%", { change, effect: change });
    if (change < -LOW_VOLUME_THRESHOLD) return result("negative", "Caída de más del 50%", { change, effect: change });
    return result("inconclusive", "La variación no supera ±50%", { change, effect: change });
  }

  // Aquí control no es null: lo garantiza la comprobación anterior.
  const controlDelta = control!.delta;
  const effect = change - controlDelta;
  const extra = { change, controlDelta, effect };
  if (Math.abs(effect) <= control!.noiseBand) {
    return result("inconclusive", "El efecto cae dentro de la banda de ruido del control", extra);
  }
  return effect > 0
    ? result("positive", "El efecto supera la banda de ruido hacia arriba", extra)
    : result("negative", "El efecto supera la banda de ruido hacia abajo", extra);
}
