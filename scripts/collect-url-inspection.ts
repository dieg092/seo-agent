// scripts/collect-url-inspection.ts
// Inspección de URLs y, después, el estado de los sitemaps según GSC (Task 6). Cada
// parte va por separado: si una falla, la otra se ejecuta igual y el script sale con 1.
import { collectUrlInspections } from "../src/collectors/urlInspectionCollector";
import { collectGscSitemaps } from "../src/collectors/gscSitemapCollector";

async function main(): Promise<number> {
  let exitCode = 0;

  try {
    const r = await collectUrlInspections();
    console.log(
      `URL Inspection: ${r.inspected} inspeccionadas, ${r.failed} con error, ${r.skippedForBudget} sin inspeccionar por presupuesto`
    );
    if (r.failed > 0) exitCode = 1;
  } catch (error) {
    console.error("URL inspection collector failed:", error);
    exitCode = 1;
  }

  try {
    const { saved } = await collectGscSitemaps();
    console.log(`Sitemaps GSC: ${saved} estados guardados`);
  } catch (error) {
    console.error("GSC sitemap collector failed:", error);
    exitCode = 1;
  }

  return exitCode;
}

main().then((code) => process.exit(code));
