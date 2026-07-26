// src/alerts/checkExternalWorkflowHeartbeat.ts
export type ExternalWorkflowRun = {
  conclusion: string | null;
  created_at: string;
  html_url: string;
};

export function isStaleOrFailed(
  run: ExternalWorkflowRun | null,
  deps: { now?: () => number; staleAfterHours?: number } = {},
): { stale: boolean; reason: string } {
  const now = deps.now ?? Date.now;
  const staleAfterHours = deps.staleAfterHours ?? 26;

  if (!run) {
    return { stale: true, reason: "No hay ninguna ejecución registrada" };
  }

  const ageHours = (now() - new Date(run.created_at).getTime()) / (1000 * 60 * 60);
  if (ageHours > staleAfterHours) {
    return { stale: true, reason: `Última ejecución hace ${ageHours.toFixed(1)}h (límite ${staleAfterHours}h)` };
  }

  if (run.conclusion !== "success") {
    return { stale: true, reason: `Última ejecución con conclusion="${run.conclusion}"` };
  }

  return { stale: false, reason: "" };
}
