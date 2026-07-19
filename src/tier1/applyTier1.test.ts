// src/tier1/applyTier1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { applyTier1 } from "./applyTier1";

// Opportunity holds real, currently-open production findings synced from live audits.
// AppliedChange records real GitHub PRs already opened by the pipeline — losing this
// history risks the pipeline re-opening duplicate PRs against real production issues.
// Back up and restore instead of wiping unscoped.
async function withEmptyOpportunities<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.opportunity.findMany({});
  await prisma.opportunity.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.opportunity.deleteMany({});
    if (backup.length > 0) {
      await prisma.opportunity.createMany({ data: backup });
    }
  }
}

async function withEmptyAppliedChanges<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.appliedChange.findMany({});
  await prisma.appliedChange.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.appliedChange.deleteMany({});
    if (backup.length > 0) {
      await prisma.appliedChange.createMany({ data: backup });
    }
  }
}

async function withEmptyTables<T>(fn: () => Promise<T>): Promise<T> {
  return withEmptyAppliedChanges(() => withEmptyOpportunities(fn));
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
  await withEmptyTables(async () => {
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
  });
});

test("applyTier1 does not open a duplicate PR for an opportunity that already has an open AppliedChange", async () => {
  await withEmptyTables(async () => {
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
  });
});

test("applyTier1 skips Tier 2/3 opportunities entirely", async () => {
  await withEmptyTables(async () => {
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
  });
});

test("applyTier1 does not open two PRs for two different robots findings that target the same file", async () => {
  await withEmptyTables(async () => {
    await makeOpenOpportunity({
      findingType: "robots-blocks-all",
      stableKey: `test-key-robots-blocks-all-${Math.random()}`,
    });
    await makeOpenOpportunity({
      findingType: "robots-missing-sitemap-directive",
      stableKey: `test-key-robots-missing-sitemap-${Math.random()}`,
    });

    let callCount = 0;
    const result = await applyTier1({
      openPr: async () => {
        callCount += 1;
        return { prUrl: `https://github.com/dieg092/wedding-invite-2/pull/${callCount}`, prNumber: callCount };
      },
      getExistingFileSha: async () => "fake-sha",
    });

    assert.equal(callCount, 1);
    assert.equal(result.prsOpened, 1);
    assert.equal(result.skippedDuplicate, 1);
  });
});

test("applyTier1 caps at 3 PRs per run even if more Tier 1 opportunities are open", async () => {
  await withEmptyTables(async () => {
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
  });
});

test("applyTier1 auto-merges the PR immediately when the finding type is graduated (autoMergeEligible)", async () => {
  await withEmptyTables(async () => {
    await prisma.graduationRecord.deleteMany({});
    await prisma.graduationRecord.create({
      data: { findingType: "robots-blocks-all", consecutiveGood: 10, autoMergeEligible: true },
    });
    await makeOpenOpportunity();

    let mergeCalled = false;
    const result = await applyTier1({
      openPr: async () => ({ prUrl: "https://github.com/dieg092/wedding-invite-2/pull/1", prNumber: 1 }),
      getExistingFileSha: async () => "fake-sha",
      mergePr: async () => {
        mergeCalled = true;
      },
    });

    assert.equal(result.prsOpened, 1);
    assert.equal(mergeCalled, true);
    const change = await prisma.appliedChange.findFirst({});
    assert.equal(change?.status, "merged");

    await prisma.graduationRecord.deleteMany({});
  });
});

test("applyTier1 leaves the PR open (no merge call) when the finding type is not graduated", async () => {
  await withEmptyTables(async () => {
    await prisma.graduationRecord.deleteMany({});
    await makeOpenOpportunity();

    let mergeCalled = false;
    const result = await applyTier1({
      openPr: async () => ({ prUrl: "https://github.com/dieg092/wedding-invite-2/pull/2", prNumber: 2 }),
      getExistingFileSha: async () => "fake-sha",
      mergePr: async () => {
        mergeCalled = true;
      },
    });

    assert.equal(result.prsOpened, 1);
    assert.equal(mergeCalled, false);
    const change = await prisma.appliedChange.findFirst({});
    assert.equal(change?.status, "open");

    await prisma.graduationRecord.deleteMany({});
  });
});
