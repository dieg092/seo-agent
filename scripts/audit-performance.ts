import { auditPerformance } from "../src/auditors/performanceAuditor";
import { prisma } from "../src/db";
import { getEnv } from "../src/env";

async function main() {
  const baseUrl = getEnv("SITE_BASE_URL");
  const sampleUrls = [
    baseUrl,
    `${baseUrl}/blog`,
    `${baseUrl}/profesionales/fotografos`,
    `${baseUrl}/glosario-bodas`,
  ];

  const results = await auditPerformance({ urls: sampleUrls });
  const runAt = new Date();

  for (const result of results) {
    await prisma.performanceAuditResult.create({
      data: {
        url: result.url,
        performanceScore: result.performanceScore,
        lcp: result.lcp,
        cls: result.cls,
        inp: result.inp,
        errors: result.errors,
        runAt,
      },
    });
  }

  const failing = results.filter((r) => r.errors.length > 0);
  console.log(`Performance: ${results.length} URLs revisadas, ${failing.length} con errores de recolección`);
  process.exit(failing.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Performance auditor failed:", error);
  process.exit(1);
});
