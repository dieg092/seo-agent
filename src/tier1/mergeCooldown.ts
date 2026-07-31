// src/tier1/mergeCooldown.ts
//
// applyTier1() puede auto-mergear un PR sin revisión humana en cuanto un
// findingType se gradúa (GraduationRecord.autoMergeEligible). Hasta ahora
// no había ningún límite de frecuencia: si el mismo archivo (hoy solo
// robots.ts, el único con fixer) generara varios hallazgos graduados en
// ejecuciones sucesivas, podría fusionarse más de una vez en poco tiempo
// sin que nadie lo revisara — riesgo señalado en la auditoría SEO/growth
// de wedding-invite-2 (2026-07-31, T10) antes de que el auto-merge se
// activara por primera vez (GraduationRecord estaba vacío en ese momento).

export function isWithinMergeCooldown(lastMergeAt: Date | null, now: Date, cooldownHours: number): boolean {
  if (!lastMergeAt) return false;
  const hoursSinceLastMerge = (now.getTime() - lastMergeAt.getTime()) / (1000 * 60 * 60);
  return hoursSinceLastMerge < cooldownHours;
}
