import { auditSitemap } from "../src/auditors/sitemapAuditor";
import { prisma } from "../src/db";

auditSitemap()
  .then(async (result) => {
    await prisma.sitemapAuditResult.create({
      data: {
        urlCount: result.urlCount,
        staleEntries: result.staleEntries,
        errors: result.errors,
      },
    });
    console.log(`Sitemap: ${result.urlCount} URLs, ${result.staleEntries} obsoletas, ${result.errors.length} errores`);
    process.exit(result.errors.length > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Sitemap auditor failed:", error);
    process.exit(1);
  });
