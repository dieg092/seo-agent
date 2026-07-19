// src/tier1/applyTier1.ts
import { prisma } from "../db";
import { getTier } from "./tierAssignment";
import { getRobotsFixerContent } from "./fixers/robotsFixer";
import { openPullRequestWithFileChange, mergePullRequest } from "./github";
import type { FindingType } from "../prioritization/types";

const MAX_PRS_PER_RUN = 3;
const ROBOTS_FILE_PATH = "src/app/robots.ts";

// Finding types whose fixer targets the same file path, keyed by that file path.
// Both robots finding types resolve to the same canonical robots.ts content, so
// an open AppliedChange for either one means the file already has a fix in flight.
const FINDING_TYPES_BY_TARGET_FILE: Record<string, FindingType[]> = {
  [ROBOTS_FILE_PATH]: ["robots-missing-sitemap-directive", "robots-blocks-all"],
};

export async function applyTier1(deps: {
  openPr?: typeof openPullRequestWithFileChange;
  getExistingFileSha?: (filePath: string) => Promise<string>;
  getFileContent?: (filePath: string) => Promise<string>;
  mergePr?: typeof mergePullRequest;
} = {}): Promise<{ prsOpened: number; skippedDuplicate: number; skippedNoFixer: number }> {
  const openPr = deps.openPr ?? openPullRequestWithFileChange;
  const getExistingFileSha =
    deps.getExistingFileSha ??
    (async () => {
      throw new Error("getExistingFileSha must be provided in production");
    });
  const getFileContent =
    deps.getFileContent ??
    (async () => {
      throw new Error("getFileContent not provided");
    });
  const mergePr = deps.mergePr ?? mergePullRequest;

  let prsOpened = 0;
  let skippedDuplicate = 0;
  let skippedNoFixer = 0;

  // Finding types already claimed (per target file) by an AppliedChange written
  // earlier in this same run, so a second opportunity of a DIFFERENT finding type
  // targeting the same file is skipped even before its own AppliedChange row
  // would have been persisted to the DB. Keyed by `${filePath}::${findingType}`.
  const findingTypesHandledThisRunByFile = new Set<string>();

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

    // The target file path for this opportunity's fixer. Currently only the
    // robots fixer exists, so this is always ROBOTS_FILE_PATH, but the lookup
    // is keyed off findingType so additional fixers/paths can be added later.
    const targetFilePath = ROBOTS_FILE_PATH;
    // Other finding types (not this opportunity's own) that resolve to the same
    // target file. Two opportunities of the SAME finding type are left to the
    // per-stableKey dedup above; this only guards against two DIFFERENT finding
    // types independently proposing a fix for the same underlying file.
    const otherFindingTypesForFile = (FINDING_TYPES_BY_TARGET_FILE[targetFilePath] ?? []).filter(
      (ft) => ft !== opportunity.findingType,
    );

    const alreadyHandledThisRun = otherFindingTypesForFile.some((ft) =>
      findingTypesHandledThisRunByFile.has(`${targetFilePath}::${ft}`),
    );
    if (alreadyHandledThisRun) {
      skippedDuplicate += 1;
      continue;
    }

    const existingChangeForFile =
      otherFindingTypesForFile.length > 0
        ? await prisma.appliedChange.findFirst({
            where: {
              findingType: { in: otherFindingTypesForFile },
              status: "open",
            },
          })
        : null;
    if (existingChangeForFile) {
      skippedDuplicate += 1;
      continue;
    }

    const newContent = getRobotsFixerContent(opportunity.findingType);
    if (!newContent) {
      skippedNoFixer += 1;
      continue;
    }

    const existingSha = await getExistingFileSha(targetFilePath);
    const branchName = `seo-agent/fix-${opportunity.findingType}-${Date.now()}`;

    let previousContent: string | null = null;
    try {
      previousContent = await getFileContent(targetFilePath);
    } catch (error) {
      console.error(
        `No se pudo capturar el contenido previo de ${targetFilePath} (revert manual si hiciera falta):`,
        error,
      );
    }

    const pr = await openPr({
      filePath: targetFilePath,
      newContent,
      branchName,
      commitMessage: `fix: ${opportunity.title}`,
      prTitle: `[SEO Agent] ${opportunity.title}`,
      prBody: `Propuesta automática del SEO Agent (Tier 1, sin auto-merge).\n\nHallazgo: ${opportunity.findingType}\n\nRevisa el diff antes de mergear.`,
      existingFileSha: existingSha,
    } as Parameters<typeof openPullRequestWithFileChange>[0]);

    const createdChange = await prisma.appliedChange.create({
      data: {
        opportunityStableKey: opportunity.stableKey,
        findingType: opportunity.findingType,
        prUrl: pr.prUrl,
        prNumber: pr.prNumber,
        status: "open",
        filePath: targetFilePath,
        previousContent,
      },
    });

    const graduationRecord = await prisma.graduationRecord.findUnique({
      where: { findingType: opportunity.findingType },
    });

    if (graduationRecord?.autoMergeEligible) {
      await mergePr({ prNumber: pr.prNumber });
      await prisma.appliedChange.update({
        where: { id: createdChange.id },
        data: { status: "merged" },
      });
    }

    findingTypesHandledThisRunByFile.add(`${targetFilePath}::${opportunity.findingType}`);
    prsOpened += 1;
  }

  return { prsOpened, skippedDuplicate, skippedNoFixer };
}
