import { applyTier1 } from "../src/tier1/applyTier1";
import { getExistingFileSha, getFileContent } from "../src/tier1/github";

async function main() {
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
