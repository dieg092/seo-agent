// src/tier1/applyTier1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { applyTier1 } from "./applyTier1";

async function resetTables() {
  await prisma.appliedChange.deleteMany({});
  await prisma.opportunity.deleteMany({});
}

function makeOpenOpportunity(overrides: Partial<Parameters<typeof prisma.opportunity.create>[0]["data"]> = {}) {
  return prisma.opportunity.create({
    data: {
      source: "robots",
      findingType: "robots-blocks-all",
      stableKey: `test-key-${Math.random()}`,
      sourceRefId: "row-1",
      title: "robots.txt bloquea todo el sitio",
      detail: {},
      impactScore: 10,
      confidenceScore: 1,
      effortScore: 1,
      priorityScore: 10,
      status: "open",
      ...overrides,
    },
  });
}

test("applyTier1 opens a PR for a new Tier 1 opportunity and records an AppliedChange", async () => {
  await resetTables();
  await makeOpenOpportunity();

  const result = await applyTier1({
    openPr: async () => ({ prUrl: "https://github.com/dieg092/wedding-invite-2/pull/1", prNumber: 1 }),
    getExistingFileSha: async () => "fake-sha",
  });

  assert.equal(result.prsOpened, 1);
  const changes = await prisma.appliedChange.findMany({});
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, "open");
  assert.equal(changes[0].prNumber, 1);

  await resetTables();
});

test("applyTier1 does not open a duplicate PR for an opportunity that already has an open AppliedChange", async () => {
  await resetTables();
  const opportunity = await makeOpenOpportunity();
  await prisma.appliedChange.create({
    data: {
      opportunityStableKey: opportunity.stableKey,
      findingType: opportunity.findingType,
      prUrl: "https://github.com/dieg092/wedding-invite-2/pull/1",
      prNumber: 1,
      status: "open",
    },
  });

  const result = await applyTier1({
    openPr: async () => {
      throw new Error("should not be called — this is the duplicate-prevention case");
    },
    getExistingFileSha: async () => "fake-sha",
  });

  assert.equal(result.prsOpened, 0);
  assert.equal(result.skippedDuplicate, 1);

  await resetTables();
});

test("applyTier1 skips Tier 2/3 opportunities entirely", async () => {
  await resetTables();
  await makeOpenOpportunity({
    findingType: "structured-data-missing",
    stableKey: `test-key-${Math.random()}`,
  });

  const result = await applyTier1({
    openPr: async () => {
      throw new Error("should not be called — this finding type is not Tier 1");
    },
    getExistingFileSha: async () => "fake-sha",
  });

  assert.equal(result.prsOpened, 0);
  const changes = await prisma.appliedChange.findMany({});
  assert.equal(changes.length, 0);

  await resetTables();
});

test("applyTier1 caps at 3 PRs per run even if more Tier 1 opportunities are open", async () => {
  await resetTables();
  for (let i = 0; i < 5; i++) {
    await makeOpenOpportunity({ stableKey: `test-key-cap-${i}` });
  }

  let callCount = 0;
  const result = await applyTier1({
    openPr: async () => {
      callCount += 1;
      return { prUrl: `https://github.com/dieg092/wedding-invite-2/pull/${callCount}`, prNumber: callCount };
    },
    getExistingFileSha: async () => "fake-sha",
  });

  assert.equal(result.prsOpened, 3);
  assert.equal(callCount, 3);

  await resetTables();
});
