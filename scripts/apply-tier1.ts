import { applyTier1 } from "../src/tier1/applyTier1";
import { getEnv } from "../src/env";

async function getExistingFileSha(filePath: string): Promise<string> {
  const owner = getEnv("GITHUB_REPO_OWNER");
  const repo = getEnv("GITHUB_REPO_NAME");
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
    {
      headers: {
        Authorization: `Bearer ${getEnv("WEDDING_INVITE_2_PAT")}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  const data = (await response.json()) as { sha: string };
  return data.sha;
}

async function main() {
  const result = await applyTier1({ getExistingFileSha });
  console.log(
    `Tier 1: ${result.prsOpened} PRs abiertos, ${result.skippedDuplicate} duplicados evitados, ${result.skippedNoFixer} sin fixer disponible`
  );
}

main().catch((error) => {
  console.error("Tier 1 apply failed:", error);
  process.exit(1);
});
