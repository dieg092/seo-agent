import { auditStructuredData } from "../src/auditors/structuredDataAuditor";
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

  const results = await auditStructuredData({ urls: sampleUrls });
  const runAt = new Date();

  for (const result of results) {
    await prisma.structuredDataAuditResult.create({
      data: {
        url: result.url,
        schemaType: result.schemaType,
        isValid: result.isValid,
        errors: result.errors,
        runAt,
      },
    });
  }

  const failing = results.filter((r) => !r.isValid);
  console.log(`Structured data: ${results.length} bloques revisados, ${failing.length} con errores`);
  process.exit(failing.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Structured data auditor failed:", error);
  process.exit(1);
});
