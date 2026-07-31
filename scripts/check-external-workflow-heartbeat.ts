// scripts/check-external-workflow-heartbeat.ts
//
// Vigila si un workflow (de este repo o de otro) ha corrido con éxito
// recientemente. El token a usar se lee de la variable de entorno cuyo
// NOMBRE se pasa como 4º argumento (por defecto GITHUB_TOKEN, el que
// GitHub Actions inyecta automáticamente y basta para leer las Actions
// de un repo público como este mismo) — así el mismo script sirve tanto
// para vigilarse a sí mismo (self-repo) como a otro repo con un PAT
// específico, sin duplicar código.
import { getEnv } from "../src/env";
import { isStaleOrFailed, type ExternalWorkflowRun } from "../src/alerts/checkExternalWorkflowHeartbeat";
import { sendTelegramMessage } from "../src/alerts/sendTelegramMessage";

async function main() {
  const [owner, repo, workflowFile, tokenEnvVar = "GITHUB_TOKEN"] = process.argv.slice(2);
  if (!owner || !repo || !workflowFile) {
    console.error(
      "Uso: check-external-workflow-heartbeat.ts <owner> <repo> <workflow-file> [token-env-var=GITHUB_TOKEN]",
    );
    process.exit(1);
  }

  const token = getEnv(tokenEnvVar);
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFile}/runs?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
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
