// src/tier2/generateBriefing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { generateBriefing } from "./generateBriefing";

// Opportunity holds real, currently-open production findings synced from live audits.
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

test("generateBriefing includes only Tier 2 open opportunities, with both articles' text for internal-link suggestions", async () => {
  await withEmptyOpportunities(async () => {
    await prisma.opportunity.create({
      data: {
        source: "internalLinking",
        findingType: "internal-link-suggestion",
        stableKey: `test-${Math.random()}`,
        sourceRefId: "ls-1",
        title: "Posible enlace interno: a → b",
        detail: { sourceSlug: "a", targetSlug: "b", similarity: 0.5 },
        impactScore: 4,
        confidenceScore: 1,
        effortScore: 2,
        priorityScore: 2,
        status: "open",
      },
    });
    // A Tier 1 opportunity should NOT appear in the Tier 2 briefing.
    await prisma.opportunity.create({
      data: {
        source: "robots",
        findingType: "robots-blocks-all",
        stableKey: `test-tier1-${Math.random()}`,
        sourceRefId: "row-1",
        title: "robots.txt bloquea todo el sitio",
        detail: {},
        impactScore: 10,
        confidenceScore: 1,
        effortScore: 1,
        priorityScore: 10,
        status: "open",
      },
    });

    const briefing = await generateBriefing({
      getArticleText: async ({ url }) => `contenido de ${url}`,
    });

    assert.ok(briefing.includes("Posible enlace interno"));
    assert.ok(briefing.includes("contenido de"));
    assert.ok(!briefing.includes("robots.txt bloquea todo el sitio"));
  });
});

test("generateBriefing reports a clean 'nothing to review' message when there are no open Tier 2 opportunities", async () => {
  await withEmptyOpportunities(async () => {
    const briefing = await generateBriefing({ getArticleText: async () => "" });

    assert.ok(briefing.toLowerCase().includes("no hay oportunidades"));
  });
});
