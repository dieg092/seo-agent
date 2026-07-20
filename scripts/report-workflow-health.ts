// scripts/report-workflow-health.ts
import { prisma } from "../src/db";
import { recordAlert } from "../src/alerts/recordAlert";

export async function reportWorkflowHealth(deps: {
  workflowName: string;
  outcomes: string[];
  runUrl: string;
  alert?: typeof recordAlert;
}): Promise<void> {
  const alert = deps.alert ?? recordAlert;
  const failed = deps.outcomes.some((outcome) => outcome === "failure");
  const status = failed ? "failed" : "ok";

  await prisma.workflowHeartbeat.upsert({
    where: { workflowName: deps.workflowName },
    create: { workflowName: deps.workflowName, lastStatus: status, lastRunUrl: deps.runUrl },
    update: { lastRunAt: new Date(), lastStatus: status, lastRunUrl: deps.runUrl },
  });

  if (failed) {
    try {
      await alert({
        type: "workflow-failed",
        subject: `Workflow "${deps.workflowName}" tuvo al menos un paso fallido`,
        body: `Al menos un paso de "${deps.workflowName}" falló en la última ejecución (algunos pasos usan continue-on-error, así que el job pudo seguir en verde en GitHub Actions). Revisa el run: ${deps.runUrl}`,
      });
    } catch (error) {
      console.error("No se pudo registrar la alerta de fallo de workflow (no bloqueante):", error);
    }
  }
}

if (require.main === module) {
  const [workflowName, outcomesArg, runUrl] = process.argv.slice(2);
  if (!workflowName || !outcomesArg || !runUrl) {
    console.error("Uso: report-workflow-health.ts <workflowName> <outcomes-separados-por-coma> <runUrl>");
    process.exit(1);
  }

  reportWorkflowHealth({ workflowName, outcomes: outcomesArg.split(","), runUrl })
    .then(() => {
      console.log(`Salud del workflow "${workflowName}" registrada.`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("report-workflow-health failed:", error);
      process.exit(1);
    });
}
