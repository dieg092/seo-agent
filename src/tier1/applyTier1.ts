// src/tier1/applyTier1.ts
import { prisma } from "../db";
import { getTier } from "./tierAssignment";
import { getRobotsFixerContent } from "./fixers/robotsFixer";
import { openPullRequestWithFileChange } from "./github";
import type { FindingType } from "../prioritization/types";

const MAX_PRS_PER_RUN = 3;
const ROBOTS_FILE_PATH = "src/app/robots.ts";

export async function applyTier1(deps: {
  openPr?: typeof openPullRequestWithFileChange;
  getExistingFileSha?: (filePath: string) => Promise<string>;
} = {}): Promise<{ prsOpened: number; skippedDuplicate: number; skippedNoFixer: number }> {
  const openPr = deps.openPr ?? openPullRequestWithFileChange;
  const getExistingFileSha =
    deps.getExistingFileSha ??
    (async () => {
      throw new Error("getExistingFileSha must be provided in production");
    });

  let prsOpened = 0;
  let skippedDuplicate = 0;
  let skippedNoFixer = 0;

  const openOpportunities = await prisma.opportunity.findMany({ where: { status: "open" } });

  for (const opportunity of openOpportunities) {
    if (prsOpened >= MAX_PRS_PER_RUN) break;

    const tier = getTier(opportunity.findingType as FindingType);
    if (tier !== 1) continue;

    const existingChange = await prisma.appliedChange.findFirst({
      where: { opportunityStableKey: opportunity.stableKey, status: "open" },
    });
    if (existingChange) {
      skippedDuplicate += 1;
      continue;
    }

    const newContent = getRobotsFixerContent(opportunity.findingType);
    if (!newContent) {
      skippedNoFixer += 1;
      continue;
    }

    const existingSha = await getExistingFileSha(ROBOTS_FILE_PATH);
    const branchName = `seo-agent/fix-${opportunity.findingType}-${Date.now()}`;

    const pr = await openPr({
      filePath: ROBOTS_FILE_PATH,
      newContent,
      branchName,
      commitMessage: `fix: ${opportunity.title}`,
      prTitle: `[SEO Agent] ${opportunity.title}`,
      prBody: `Propuesta automática del SEO Agent (Tier 1, sin auto-merge).\n\nHallazgo: ${opportunity.findingType}\n\nRevisa el diff antes de mergear.`,
      existingFileSha: existingSha,
    } as Parameters<typeof openPullRequestWithFileChange>[0]);

    await prisma.appliedChange.create({
      data: {
        opportunityStableKey: opportunity.stableKey,
        findingType: opportunity.findingType,
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
        status: "open",
      },
    });

    prsOpened += 1;
  }

  return { prsOpened, skippedDuplicate, skippedNoFixer };
}
