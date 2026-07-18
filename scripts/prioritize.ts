import { computeCurrentFindings, syncOpportunities } from "../src/prioritization/prioritize";

async function main() {
  const findings = await computeCurrentFindings();
  const result = await syncOpportunities(findings);

  console.log(
    `Priorización: ${result.created} nuevas, ${result.reopened} reabiertas, ${result.updated} actualizadas, ${result.resolved} resueltas`
  );
}

main().catch((error) => {
  console.error("Priority engine failed:", error);
  process.exit(1);
});
