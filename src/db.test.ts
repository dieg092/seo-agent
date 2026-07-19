import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./db";

test("prisma client can read from the seo_agent schema", async () => {
  const count = await prisma.searchConsoleSnapshot.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the Opportunity table", async () => {
  const count = await prisma.opportunity.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the PerformanceAuditResult table", async () => {
  const count = await prisma.performanceAuditResult.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the AppliedChange table", async () => {
  const count = await prisma.appliedChange.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the ArticleEmbedding table", async () => {
  const count = await prisma.articleEmbedding.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the LinkSuggestion table", async () => {
  const count = await prisma.linkSuggestion.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the GraduationRecord table", async () => {
  const count = await prisma.graduationRecord.count();
  assert.equal(typeof count, "number");
});

test("prisma client can read from the ImpactMeasurement table", async () => {
  const count = await prisma.impactMeasurement.count();
  assert.equal(typeof count, "number");
});

test("AppliedChange accepts filePath/previousContent/revertsAppliedChangeId as optional fields", async () => {
  const created = await prisma.appliedChange.create({
    data: {
      opportunityStableKey: `test-schema-${Math.random()}`,
      findingType: "robots-blocks-all",
      prUrl: "https://github.com/x/y/pull/999",
      prNumber: 999,
      status: "open",
    },
  });
  assert.equal(created.filePath, null);
  assert.equal(created.previousContent, null);
  assert.equal(created.revertsAppliedChangeId, null);

  const updated = await prisma.appliedChange.update({
    where: { id: created.id },
    data: { filePath: "src/app/robots.ts", previousContent: "old content", revertsAppliedChangeId: "some-id" },
  });
  assert.equal(updated.filePath, "src/app/robots.ts");
  assert.equal(updated.previousContent, "old content");
  assert.equal(updated.revertsAppliedChangeId, "some-id");

  await prisma.appliedChange.delete({ where: { id: created.id } });
});
