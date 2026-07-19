// scripts/detect-site-architecture.ts
import {
  getTemplatePerformanceHistory,
  getNearDuplicatePairs,
  getMissingProvincialTemplateCandidates,
} from "../src/siteArchitecture/queries";
import { extractSiteArchitectureFindings } from "../src/prioritization/classify";
import { syncOpportunities } from "../src/prioritization/prioritize";

async function main() {
  const [templatePerformance, nearDuplicates, missingTemplates] = await Promise.all([
    getTemplatePerformanceHistory(),
    getNearDuplicatePairs(),
    getMissingProvincialTemplateCandidates(),
  ]);

  const findings = extractSiteArchitectureFindings({ templatePerformance, nearDuplicates, missingTemplates });

  const result = await syncOpportunities(findings, { sourcesInScope: ["siteArchitecture"] });

  console.log(
    `Arquitectura del Sitio: ${result.created} nuevas, ${result.reopened} reabiertas, ${result.updated} actualizadas, ${result.resolved} resueltas`
  );
}

main().catch((error) => {
  console.error("Site architecture detection failed:", error);
  process.exit(1);
});
