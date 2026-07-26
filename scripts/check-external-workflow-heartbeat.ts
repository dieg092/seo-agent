// scripts/check-external-workflow-heartbeat.ts
//
// Vigila desde fuera si un workflow de OTRO repo (wedding-invite-2) ha
// corrido con éxito recientemente. Existe porque si GitHub bloquea el
// runner de wedding-invite-2 antes de arrancar (p. ej. el problema de
// facturación de la cuenta), ningún paso de ESE workflow llega a
// ejecutarse — ni el que manda el aviso de fallo a Telegram. seo-agent es
// público (gratis, no le afecta ese bloqueo) y ya tiene un PAT de lectura
// sobre wedding-invite-2 (WEDDING_INVITE_2_PAT), así que puede detectar
// ese silencio desde fuera.
import { getEnv } from "../src/env";
import { isStaleOrFailed, type ExternalWorkflowRun } from "../src/alerts/checkExternalWorkflowHeartbeat";
import { sendTelegramMessage } from "../src/alerts/sendTelegramMessage";

async function main() {
  const [owner, repo, workflowFile] = process.argv.slice(2);
  if (!owner || !repo || !workflowFile) {
    console.error("Uso: check-external-workflow-heartbeat.ts <owner> <repo> <workflow-file>");
    process.exit(1);
  }

  const pat = getEnv("WEDDING_INVITE_2_PAT");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" },
  });

  if (!res.ok) {
    throw new Error(`GitHub API devolvió ${res.status} al consultar runs de ${owner}/${repo}/${workflowFile}`);
  }

  const body = (await res.json()) as { workflow_runs: ExternalWorkflowRun[] };
  const latest = body.workflow_runs[0] ?? null;

  const { stale, reason } = isStaleOrFailed(latest);

  if (stale) {
    const message = `⚠️ <b>${owner}/${repo}</b>: "${workflowFile}" no tiene una ejecución reciente y exitosa.\n${reason}${latest ? `\n${latest.html_url}` : ""}`;
    console.log(message);
    await sendTelegramMessage(message);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${owner}/${repo}/${workflowFile} tiene una ejecución reciente y exitosa.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
