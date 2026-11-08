// src/prioritization/priority.ts
// Algoritmo de prioridad (spec maestra §12.2, ADR-08). Función pura: la
// puntuación solo ordena y se guarda junto con todos sus factores.
import type { Autonomy, ConfidenceKind, Severity } from "./catalog";

export type Intent = "product" | "professional" | "content" | "other";

export const SEVERITY_WEIGHT: Readonly<Record<Severity, number>> = { critical: 10, high: 5, medium: 2.5, low: 1 };
export const INTENT_WEIGHT: Readonly<Record<Intent, number>> = { product: 1.0, professional: 0.6, content: 0.2, other: 0 };
export const CONFIDENCE_WEIGHT: Readonly<Record<ConfidenceKind, number>> = { observed: 1.0, derived: 0.8, heuristic: 0.5 };
export const RISK_WEIGHT: Readonly<Record<Autonomy, number>> = { A1: 1, A2: 1.3, A3: 1 };

/** Mediciones evaluables mínimas de una operación para que cuente `learning`. */
export const MIN_LEARNING_MEASUREMENTS = 5;

export interface FunnelValue {
  revenueEur90d: number;
  payments90d: number;
  qualifiedSignups90d: number;
}

export interface PriorityInput {
  severity: Severity;
  confidence: ConfidenceKind;
  autonomy: Autonomy;
  /** Heurística 1–10 por tipo (Anexo B). */
  effort: number;
  intent: Intent;
  /** Embudo de la página en 90 días; null si no hay datos (value = 1 + intentW). */
  funnel: FunnelValue | null;
  /** Riesgo de perder la indexación de páginas con valor. */
  indexationRisk: boolean;
  /** Resultados evaluables de la misma operation; null si no se usa todavía. */
  learning: { positive: number; negative: number } | null;
  weeksOpen: number;
}

export interface PriorityFactors {
  severityW: number;
  intentW: number;
  value: number;
  confidenceW: number;
  urgency: number;
  learning: number;
  aging: number;
  effort: number;
  riskW: number;
}

export interface PriorityResult {
  score: number;
  factors: PriorityFactors;
}

function clamp(min: number, max: number, x: number): number {
  return Math.min(max, Math.max(min, x));
}

/** value de §12.2: una página sin datos del embudo nunca vale 0. */
export function computeValue(intent: Intent, funnel: FunnelValue | null): number {
  const base = 1 + INTENT_WEIGHT[intent];
  if (!funnel) return base;
  const revenue = Math.max(0, funnel.revenueEur90d);
  const conversions = Math.max(0, funnel.payments90d) + 0.3 * Math.max(0, funnel.qualifiedSignups90d);
  return base + Math.min(2, Math.log10(1 + revenue / 10)) + Math.min(1, Math.log10(1 + conversions));
}

/** learning de §12.2: 2 × E[Beta(1+pos, 1+neg)], acotado a [0,5, 1,5], con ≥ 5 mediciones. */
export function computeLearning(stats: { positive: number; negative: number } | null): number {
  if (!stats) return 1;
  const { positive, negative } = stats;
  if (positive + negative < MIN_LEARNING_MEASUREMENTS) return 1;
  const mean = (1 + positive) / (2 + positive + negative);
  return clamp(0.5, 1.5, 2 * mean);
}

export function computeAging(weeksOpen: number): number {
  return Math.min(1.5, 1 + 0.05 * Math.max(0, weeksOpen));
}

export function computePriority(input: PriorityInput): PriorityResult {
  const intentW = INTENT_WEIGHT[input.intent];
  const factors: PriorityFactors = {
    severityW: SEVERITY_WEIGHT[input.severity],
    intentW,
    value: computeValue(input.intent, input.funnel),
    confidenceW: CONFIDENCE_WEIGHT[input.confidence],
    urgency: input.indexationRisk ? 3 : 1,
    learning: computeLearning(input.learning),
    aging: computeAging(input.weeksOpen),
    effort: clamp(1, 10, input.effort),
    riskW: RISK_WEIGHT[input.autonomy],
  };
  const score =
    (factors.severityW * factors.value * factors.confidenceW * factors.urgency * factors.learning * factors.aging) /
    (factors.effort * factors.riskW);
  return { score, factors };
}

/** `value × severityW`: lo que se compara para reabrir un hallazgo descartado (Anexo B.1). */
export function dismissalValue(factors: PriorityFactors): number {
  return factors.value * factors.severityW;
}

/** Primeros segmentos de las páginas que venden el producto. */
const PRODUCT_SEGMENTS = new Set(["precios", "plantillas", "funcionalidades", "invitacion-digital-boda", "tool"]);
const PROFESSIONAL_SEGMENTS = new Set(["profesionales", "colaboraciones"]);
const CONTENT_SEGMENTS = new Set([
  "blog",
  "glosario-bodas",
  "estadisticas-bodas",
  "organizar-boda-guia",
  "calculadora-presupuesto-boda",
  "herramientas",
]);

/** Intención de una página por su ruta. La home es `product`; sin página, `other`. */
export function intentOfPage(page: string | null): Intent {
  if (!page) return "other";
  let path: string;
  try {
    path = page.startsWith("/") ? page : new URL(page).pathname;
  } catch {
    return "other";
  }
  const first = path.split(/[?#]/)[0].split("/").filter((s) => s.length > 0)[0];
  if (first === undefined) return "product";
  if (PRODUCT_SEGMENTS.has(first)) return "product";
  if (PROFESSIONAL_SEGMENTS.has(first)) return "professional";
  if (CONTENT_SEGMENTS.has(first)) return "content";
  return "other";
}

/**
 * Página afectada por un hallazgo, si la hay: `detail.page`, `detail.url`,
 * `detail.sourceSlug` (artículo del blog) o la primera URL de `stableKeyInput`.
 */
export function pageOfFinding(finding: { detail: unknown; stableKeyInput: string }): string | null {
  const detail = finding.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    if (typeof d.page === "string" && d.page.length > 0) return d.page;
    if (typeof d.url === "string" && d.url.length > 0) return d.url;
    if (typeof d.sourceSlug === "string" && d.sourceSlug.length > 0) return `/blog/${d.sourceSlug}`;
  }
  // Las URLs del stableKeyInput pueden ir seguidas de «:tipoDeSchema»: se corta en el «:» de la ruta.
  const match = finding.stableKeyInput.match(/https?:\/\/[^\s:/]+(?::\d+)?[^\s:]*/);
  return match ? match[0] : null;
}
