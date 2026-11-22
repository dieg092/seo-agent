// scripts/collect-agent-readiness.ts
// Nota diaria de isitagentready.com para la home (perfiles «content» y «all") →
// AgentReadinessScan. Avisa si una comprobación que pasaba deja de pasar.
import { prisma } from "../src/db";
import { collectAgentReadiness, score } from "../src/collectors/agentReadinessCollector";

const WORKFLOW = "agent-readiness";

async function main(): Promise<number> {
  let status = "ok";
  try {
    const r = await collectAgentReadiness();
    for (const [profile, scan] of Object.entries(r)) {
      console.log(`Agent readiness ${profile}: ${score(scan)}/100 (${scan.passed}/${scan.total}), nivel ${scan.level} ${scan.levelName}`);
    }
    return 0;
  } catch (error) {
    status = "failed";
    console.error("collect-agent-readiness failed:", error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await prisma.workflowHeartbeat
      .upsert({
        where: { workflowName: WORKFLOW },
        create: { workflowName: WORKFLOW, lastStatus: status },
        update: { lastRunAt: new Date(), lastStatus: status },
      })
      .catch(() => {});
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
