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
