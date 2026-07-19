// src/graduation/measureImpact.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { measureAppliedChanges } from "./measureImpact";

async function resetTables() {
  await prisma.impactMeasurement.deleteMany({});
  await prisma.graduationRecord.deleteMany({});
  await prisma.appliedChange.deleteMany({});
  await prisma.opportunity.deleteMany({});
}

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

test("measureAppliedChanges measures a robots-type change site-wide and increments the graduation counter on a positive outcome", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/a" } });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/1",
      prNumber: 1,
      status: "merged",
    },
  });
  // updatedAt is set by @updatedAt on create/update; force it to the intended mergedAt for a deterministic test.
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );

  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/a", query: "q", clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/a", query: "q", clicks: 12, impressions: 100, ctr: 0.12, position: 5 },
  });

  const result = await measureAppliedChanges();

  assert.equal(result.measured, 1);
  const measurement = await prisma.impactMeasurement.findUnique({ where: { appliedChangeId: change.id } });
  assert.equal(measurement?.outcome, "positive");

  const record = await prisma.graduationRecord.findUnique({ where: { findingType: "robots-blocks-all" } });
  assert.equal(record?.consecutiveGood, 1);
  assert.equal(record?.autoMergeEligible, false);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/a" } });
  await resetTables();
});

test("measureAppliedChanges resets consecutiveGood and revokes autoMergeEligible on a negative outcome, even if already graduated", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/b" } });

  await prisma.graduationRecord.create({
    data: { findingType: "robots-blocks-all", consecutiveGood: 10, autoMergeEligible: true },
  });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/2",
      prNumber: 2,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );

  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/b", query: "q", clicks: 100, impressions: 500, ctr: 0.2, position: 3 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/b", query: "q", clicks: 50, impressions: 500, ctr: 0.1, position: 6 },
  });

  await measureAppliedChanges();

  const record = await prisma.graduationRecord.findUnique({ where: { findingType: "robots-blocks-all" } });
  assert.equal(record?.consecutiveGood, 0);
  assert.equal(record?.autoMergeEligible, false);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/b" } });
  await resetTables();
});

test("measureAppliedChanges measures an internal-link-suggestion change against its own source article's page", async () => {
  await resetTables();
  const page = "https://miwebdeboda.com/blog/measure-test-slug";
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page } });

  const opportunity = await prisma.opportunity.create({
    data: {
      source: "internalLinking",
      findingType: "internal-link-suggestion",
      stableKey: `test-opp-${Math.random()}`,
      sourceRefId: "x",
      title: "test",
      detail: { sourceSlug: "measure-test-slug", targetSlug: "other-slug", similarity: 0.5 },
      impactScore: 4,
      confidenceScore: 1,
      effortScore: 2,
      priorityScore: 2,
      status: "open",
    },
  });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: opportunity.stableKey,
      findingType: "internal-link-suggestion",
      prUrl: "https://github.com/x/y/pull/3",
      prNumber: 3,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );

  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page, query: "q", clicks: 20, impressions: 100, ctr: 0.2, position: 4 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page, query: "q", clicks: 25, impressions: 100, ctr: 0.25, position: 3 },
  });

  const result = await measureAppliedChanges();

  assert.equal(result.measured, 1);
  const measurement = await prisma.impactMeasurement.findUnique({ where: { appliedChangeId: change.id } });
  assert.equal(measurement?.outcome, "positive");
  assert.equal(measurement?.beforeMetric, 20);
  assert.equal(measurement?.afterMetric, 25);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page } });
  await resetTables();
});

test("measureAppliedChanges skips changes merged less than 14 days ago", async () => {
  await resetTables();

  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/4",
      prNumber: 4,
      status: "merged",
    },
  });
  // Freshly created — updatedAt is "now", well within the 14-day cooldown.

  const result = await measureAppliedChanges();

  assert.equal(result.measured, 0);
  const measurement = await prisma.impactMeasurement.findUnique({ where: { appliedChangeId: change.id } });
  assert.equal(measurement, null);

  await resetTables();
});

test("measureAppliedChanges reports newly-graduated findingTypes and does not re-report already-graduated ones", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/grad" } });

  await prisma.graduationRecord.create({
    data: { findingType: "robots-blocks-all", consecutiveGood: 9, autoMergeEligible: false },
  });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/5",
      prNumber: 5,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );

  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/grad", query: "q", clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/grad", query: "q", clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  });

  const result = await measureAppliedChanges();

  assert.deepEqual(result.graduated, ["robots-blocks-all"]);
  const record = await prisma.graduationRecord.findUnique({ where: { findingType: "robots-blocks-all" } });
  assert.equal(record?.consecutiveGood, 10);
  assert.equal(record?.autoMergeEligible, true);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/grad" } });
  await resetTables();
});

test("measureAppliedChanges opens a revert PR and sends an alert when a merged change with previousContent shows negative impact", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/revert-a" } });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/10",
      prNumber: 10,
      status: "merged",
      filePath: "src/app/robots.ts",
      previousContent: "export const original = true;",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/revert-a", query: "q", clicks: 100, impressions: 500, ctr: 0.2, position: 3 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/revert-a", query: "q", clicks: 50, impressions: 500, ctr: 0.1, position: 6 },
  });

  let openPrCalled = false;
  let openPrArgs: { filePath: string; newContent: string } | undefined;
  let alertCalled = false;

  await measureAppliedChanges({
    openPr: async (args) => {
      openPrCalled = true;
      openPrArgs = args as { filePath: string; newContent: string };
      return { prUrl: "https://github.com/x/y/pull/11", prNumber: 11 };
    },
    getExistingFileSha: async () => "current-sha",
    alert: async () => {
      alertCalled = true;
    },
  });

  assert.equal(openPrCalled, true);
  assert.equal(openPrArgs?.filePath, "src/app/robots.ts");
  assert.equal(openPrArgs?.newContent, "export const original = true;");
  assert.equal(alertCalled, true);

  const revertChange = await prisma.appliedChange.findFirst({ where: { findingType: "revert" } });
  assert.equal(revertChange?.status, "open");
  assert.equal(revertChange?.revertsAppliedChangeId, change.id);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/revert-a" } });
  await resetTables();
});

test("measureAppliedChanges sends an alert (no revert PR) when previousContent is missing", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/revert-b" } });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/12",
      prNumber: 12,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/revert-b", query: "q", clicks: 100, impressions: 500, ctr: 0.2, position: 3 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/revert-b", query: "q", clicks: 50, impressions: 500, ctr: 0.1, position: 6 },
  });

  let openPrCalled = false;
  let alertBody = "";

  await measureAppliedChanges({
    openPr: async () => {
      openPrCalled = true;
      return { prUrl: "x", prNumber: 1 };
    },
    alert: async (args) => {
      alertBody = args.body;
    },
  });

  assert.equal(openPrCalled, false);
  assert.match(alertBody, /reversión manual/);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/revert-b" } });
  await resetTables();
});

test("measureAppliedChanges reports revoked findingTypes when a negative outcome hits an already-graduated category", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/revoke" } });

  await prisma.graduationRecord.create({
    data: { findingType: "robots-blocks-all", consecutiveGood: 10, autoMergeEligible: true },
  });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/13",
      prNumber: 13,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/revoke", query: "q", clicks: 100, impressions: 500, ctr: 0.2, position: 3 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/revoke", query: "q", clicks: 50, impressions: 500, ctr: 0.1, position: 6 },
  });

  const result = await measureAppliedChanges({
    alert: async () => {},
  });

  assert.deepEqual(result.revoked, ["robots-blocks-all"]);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/revoke" } });
  await resetTables();
});

test("measureAppliedChanges alerts on newly-graduated findingTypes", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/grad-alert" } });

  await prisma.graduationRecord.create({
    data: { findingType: "robots-blocks-all", consecutiveGood: 9, autoMergeEligible: false },
  });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/14",
      prNumber: 14,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/grad-alert", query: "q", clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/grad-alert", query: "q", clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
  });

  let alertCount = 0;
  await measureAppliedChanges({
    alert: async () => {
      alertCount += 1;
    },
  });

  assert.equal(alertCount, 1);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/grad-alert" } });
  await resetTables();
});

test("measureAppliedChanges does not throw when alert dispatch fails (best-effort)", async () => {
  await resetTables();
  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/alert-fail" } });

  const mergedAt = daysAgo(15);
  const change = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/15",
      prNumber: 15,
      status: "merged",
    },
  });
  await prisma.$executeRawUnsafe(
    `UPDATE "seo_agent"."AppliedChange" SET "updatedAt" = $1 WHERE "id" = $2`,
    mergedAt,
    change.id
  );
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() - 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/alert-fail", query: "q", clicks: 100, impressions: 500, ctr: 0.2, position: 3 },
  });
  await prisma.searchConsoleSnapshot.create({
    data: { date: new Date(mergedAt.getTime() + 5 * 24 * 60 * 60 * 1000), page: "https://measure-test.example/alert-fail", query: "q", clicks: 50, impressions: 500, ctr: 0.1, position: 6 },
  });

  const result = await measureAppliedChanges({
    alert: async () => {
      throw new Error("Alert DB write failed");
    },
  });

  assert.equal(result.measured, 1);

  await prisma.searchConsoleSnapshot.deleteMany({ where: { page: "https://measure-test.example/alert-fail" } });
  await resetTables();
});
