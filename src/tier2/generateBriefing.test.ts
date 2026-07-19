// src/tier2/generateBriefing.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { generateBriefing } from "./generateBriefing";

async function resetTable() {
  await prisma.opportunity.deleteMany({});
}

test("generateBriefing includes only Tier 2 open opportunities, with both articles' text for internal-link suggestions", async () => {
  await resetTable();

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

  await resetTable();
});

test("generateBriefing reports a clean 'nothing to review' message when there are no open Tier 2 opportunities", async () => {
  await resetTable();

  const briefing = await generateBriefing({ getArticleText: async () => "" });

  assert.ok(briefing.toLowerCase().includes("no hay oportunidades"));

  await resetTable();
});
