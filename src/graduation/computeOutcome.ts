// src/graduation/computeOutcome.ts
const NEGATIVE_IMPACT_THRESHOLD = 0.15;

export function computeOutcome(before: number, after: number): "positive" | "negative" | "inconclusive" {
  if (before === 0) return "inconclusive";
  const change = (after - before) / before;
  return change <= -NEGATIVE_IMPACT_THRESHOLD ? "negative" : "positive";
}
