import { auditRobots } from "../src/auditors/robotsAuditor";
import { prisma } from "../src/db";

auditRobots()
  .then(async (result) => {
    await prisma.robotsAuditResult.create({
      data: { isValid: result.isValid, errors: result.errors },
    });
    console.log(`Robots: ${result.isValid ? "válido" : "con errores"} (${result.errors.length} errores)`);
    process.exit(result.isValid ? 0 : 1);
  })
  .catch((error) => {
    console.error("Robots auditor failed:", error);
    process.exit(1);
  });
