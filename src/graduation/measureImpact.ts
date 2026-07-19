// src/graduation/measureImpact.ts
import { prisma } from "../db";
import { getEnv } from "../env";
import { computeOutcome } from "./computeOutcome";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const GRADUATION_THRESHOLD = 10;

async function sumClicksSiteWide(start: Date, end: Date): Promise<number> {
  const rows = await prisma.searchConsoleSnapshot.findMany({
    where: { date: { gte: start, lt: end } },
    select: { clicks: true },
  });
  return rows.reduce((sum, r) => sum + r.clicks, 0);
}

async function sumClicksForPage(page: string, start: Date, end: Date): Promise<number> {
  const rows = await prisma.searchConsoleSnapshot.findMany({
    where: { page, date: { gte: start, lt: end } },
    select: { clicks: true },
  });
  return rows.reduce((sum, r) => sum + r.clicks, 0);
}

export async function measureAppliedChanges(): Promise<{ measured: number; graduated: string[] }> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);

  const candidates = await prisma.appliedChange.findMany({
    where: { status: "merged", updatedAt: { lte: cutoff } },
  });

  let measured = 0;
  const graduated: string[] = [];

  for (const change of candidates) {
    const already = await prisma.impactMeasurement.findUnique({ where: { appliedChangeId: change.id } });
    if (already) continue;

    const mergedAt = change.updatedAt;
    let before: number;
    let after: number;

    if (change.findingType === "internal-link-suggestion") {
      const opportunity = await prisma.opportunity.findUnique({ where: { stableKey: change.opportunityStableKey } });
      const detail = opportunity?.detail as { sourceSlug?: string } | null;
      if (!detail?.sourceSlug) continue;
      const baseUrl = getEnv("SITE_BASE_URL");
      const page = `${baseUrl}/blog/${detail.sourceSlug}`;
      before = await sumClicksForPage(page, new Date(mergedAt.getTime() - WINDOW_MS), mergedAt);
      after = await sumClicksForPage(page, mergedAt, new Date(mergedAt.getTime() + WINDOW_MS));
    } else {
      before = await sumClicksSiteWide(new Date(mergedAt.getTime() - WINDOW_MS), mergedAt);
      after = await sumClicksSiteWide(mergedAt, new Date(mergedAt.getTime() + WINDOW_MS));
    }

    const outcome = computeOutcome(before, after);

    await prisma.impactMeasurement.create({
      data: {
        appliedChangeId: change.id,
        findingType: change.findingType,
        outcome,
        beforeMetric: before,
        afterMetric: after,
      },
    });
    measured += 1;

    const record = await prisma.graduationRecord.findUnique({ where: { findingType: change.findingType } });

    if (outcome === "negative") {
      await prisma.graduationRecord.upsert({
        where: { findingType: change.findingType },
        create: { findingType: change.findingType, consecutiveGood: 0, autoMergeEligible: false },
        update: { consecutiveGood: 0, autoMergeEligible: false },
      });
    } else {
      const newCount = (record?.consecutiveGood ?? 0) + 1;
      const nowEligible = newCount >= GRADUATION_THRESHOLD;
      await prisma.graduationRecord.upsert({
        where: { findingType: change.findingType },
        create: { findingType: change.findingType, consecutiveGood: newCount, autoMergeEligible: nowEligible },
        update: { consecutiveGood: newCount, autoMergeEligible: nowEligible },
      });
      if (nowEligible && !record?.autoMergeEligible) {
        graduated.push(change.findingType);
      }
    }
  }

  return { measured, graduated };
}
