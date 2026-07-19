// src/tier2/generateBriefing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
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

test("generateBriefing skips a malformed internal-link-suggestion detail without aborting the whole briefing", async () => {
  await withEmptyOpportunities(async () => {
    await prisma.opportunity.create({
      data: {
        source: "internalLinking",
        findingType: "internal-link-suggestion",
        stableKey: `test-${Math.random()}`,
        sourceRefId: "ls-well-formed",
        title: "Posible enlace interno: c → d",
        detail: { sourceSlug: "c", targetSlug: "d", similarity: 0.7 },
        impactScore: 4,
        confidenceScore: 1,
        effortScore: 2,
        priorityScore: 3,
        status: "open",
      },
    });
    // Malformed detail: stored as JSON null (Json columns have no DB-level schema
    // enforcement, so a row can legitimately end up with detail === null at runtime).
    // Accessing detail.sourceSlug on null throws, which is exactly the crash this test guards against.
    await prisma.opportunity.create({
      data: {
        source: "internalLinking",
        findingType: "internal-link-suggestion",
        stableKey: `test-${Math.random()}`,
        sourceRefId: "ls-malformed",
        title: "Posible enlace interno: roto",
        detail: Prisma.JsonNull,
        impactScore: 4,
        confidenceScore: 1,
        effortScore: 2,
        priorityScore: 2.5,
        status: "open",
      },
    });

    const briefing = await generateBriefing({
      getArticleText: async ({ url }) => `contenido de ${url}`,
    });

    // The well-formed opportunity still gets its full section with fetched article text.
    assert.ok(briefing.includes("Posible enlace interno: c → d"));
    assert.ok(briefing.includes("contenido de"));

    // The malformed opportunity is flagged as skipped/malformed, not silently dropped or crashing.
    assert.ok(briefing.includes("Posible enlace interno: roto"));
    assert.ok(briefing.includes("ls-malformed"));
    assert.ok(/malformad|inválid|invalid|skip|omitid/i.test(briefing));
  });
});
