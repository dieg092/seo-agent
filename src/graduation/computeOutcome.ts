// src/graduation/computeOutcome.ts
const NEGATIVE_IMPACT_THRESHOLD = 0.15;

// Con pocos clics un -15% es ruido (8 → 2 en tendencias-bodas-2027 abrió una
// reversión del PR #99 en oct-2026 cuando la posición no se había movido).
// Por debajo de este volumen en las 2 semanas previas no hay veredicto.
const MIN_BASELINE_CLICKS = 20;

export function computeOutcome(before: number, after: number): "positive" | "negative" | "inconclusive" {
  if (before < MIN_BASELINE_CLICKS) return "inconclusive";
  const change = (after - before) / before;
  return change <= -NEGATIVE_IMPACT_THRESHOLD ? "negative" : "positive";
}
