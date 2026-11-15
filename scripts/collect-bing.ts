// scripts/collect-bing.ts
// Fase 6 (§10.6): consultas, páginas y rastreo de Bing Webmaster → BingQueryStat,
// BingPageStat y BingCrawlStat. Necesita BING_WEBMASTER_API_KEY. Semanal.
import { prisma } from "../src/db";
import { collectBingWebmaster } from "../src/collectors/bingWebmasterCollector";

const WORKFLOW = "bing-collector";

async function main(): Promise<number> {
  let status = "ok";
  try {
    const r = await collectBingWebmaster();
    console.log(`Bing: ${r.queries} consultas, ${r.pages} páginas, ${r.crawlDays} días de rastreo, ${r.privateSeen} URLs privadas redactadas`);
    return 0;
  } catch (error) {
    status = "failed";
    console.error("collect-bing failed:", error instanceof Error ? error.message : error);
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
