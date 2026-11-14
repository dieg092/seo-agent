import { applyTier1 } from "../src/tier1/applyTier1";
import { getExistingFileSha, getFileContent } from "../src/tier1/github";
import { readControl } from "../src/brake/control";

async function main() {
  // Freno e interruptor (§14): sin poder leerlos, o con alguno activo, no se abre ningún PR SEO.
  const control = await readControl();
  if (!control || control.masterSwitch !== "on" || control.brakeState === "tripped" || control.pausedLanes.includes("technical")) {
    console.log(`Tier 1: omitido por el freno SEO (${control ? `interruptor ${control.masterSwitch}, freno ${control.brakeState}` : "no se pudo leer SeoControl"})`);
    return;
  }
  const result = await applyTier1({
    getExistingFileSha: (filePath: string) => getExistingFileSha({ filePath }),
    getFileContent: (filePath: string) => getFileContent({ filePath }),
  });
  console.log(
    `Tier 1: ${result.prsOpened} PRs abiertos, ${result.skippedDuplicate} duplicados evitados, ${result.skippedNoFixer} sin fixer disponible`
  );
}

main().catch((error) => {
  console.error("Tier 1 apply failed:", error);
  process.exit(1);
});
