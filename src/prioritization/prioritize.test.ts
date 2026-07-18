import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { computeCurrentFindings, syncOpportunities } from "./prioritize";

async function resetAuditTables() {
  await prisma.opportunity.deleteMany({});
  await prisma.sitemapAuditResult.deleteMany({});
  await prisma.robotsAuditResult.deleteMany({});
  await prisma.structuredDataAuditResult.deleteMany({});
  await prisma.performanceAuditResult.deleteMany({});
}

test("computeCurrentFindings + syncOpportunities creates an Opportunity from a real robots finding", async () => {
  await resetAuditTables();

  await prisma.robotsAuditResult.create({
    data: { isValid: false, errors: ["robots.txt contiene 'Disallow: /' — bloquearía la indexación de todo el sitio"] },
  });

  const findings = await computeCurrentFindings();
  const result = await syncOpportunities(findings);

  assert.equal(result.created, 1);
  const opportunities = await prisma.opportunity.findMany({ where: { status: "open" } });
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].findingType, "robots-blocks-all");
  assert.equal(opportunities[0].impactScore, 10);
  assert.equal(opportunities[0].priorityScore, 10);

  await resetAuditTables();
});

test("running syncOpportunities twice with the same findings does not duplicate", async () => {
  await resetAuditTables();

  await prisma.robotsAuditResult.create({
    data: { isValid: false, errors: ["robots.txt no declara ninguna directiva Sitemap:"] },
  });

  const findings1 = await computeCurrentFindings();
  await syncOpportunities(findings1);
  const findings2 = await computeCurrentFindings();
  const result2 = await syncOpportunities(findings2);

  assert.equal(result2.created, 0);
  assert.equal(result2.updated, 1);
  const opportunities = await prisma.opportunity.findMany({});
  assert.equal(opportunities.length, 1);

  await resetAuditTables();
});

test("an Opportunity is auto-resolved when its finding disappears, then reopened if it reappears", async () => {
  await resetAuditTables();

  await prisma.robotsAuditResult.create({
    data: { isValid: false, errors: ["robots.txt no declara ninguna directiva Sitemap:"] },
  });
  await syncOpportunities(await computeCurrentFindings());

  // Second run: robots.txt is now fixed, no errors.
  await prisma.robotsAuditResult.create({ data: { isValid: true, errors: [] } });
  const resultResolved = await syncOpportunities(await computeCurrentFindings());

  assert.equal(resultResolved.resolved, 1);
  let opportunity = await prisma.opportunity.findFirstOrThrow({});
  assert.equal(opportunity.status, "resolved");
  assert.ok(opportunity.resolvedAt);

  // Third run: the same problem comes back.
  await prisma.robotsAuditResult.create({
    data: { isValid: false, errors: ["robots.txt no declara ninguna directiva Sitemap:"] },
  });
  const resultReopened = await syncOpportunities(await computeCurrentFindings());

  assert.equal(resultReopened.reopened, 1);
  opportunity = await prisma.opportunity.findFirstOrThrow({});
  assert.equal(opportunity.status, "open");
  assert.equal(opportunity.resolvedAt, null);

  await resetAuditTables();
});

test("computeCurrentFindings only reads the most recent structuredData batch, not older runs", async () => {
  await resetAuditTables();

  const olderRunAt = new Date(Date.now() - 60_000);
  await prisma.structuredDataAuditResult.create({
    data: { url: "https://example.com/old", schemaType: "none", isValid: false, errors: ["stale"], runAt: olderRunAt },
  });

  const newerRunAt = new Date();
  await prisma.structuredDataAuditResult.create({
    data: { url: "https://example.com/new", schemaType: "none", isValid: false, errors: ["fresh"], runAt: newerRunAt },
  });

  const findings = await computeCurrentFindings();
  const structuredDataFindings = findings.filter((f) => f.source === "structuredData");

  assert.equal(structuredDataFindings.length, 1);
  assert.ok(String(structuredDataFindings[0].stableKeyInput).includes("example.com/new"));

  await resetAuditTables();
});

test("computeCurrentFindings returns no findings when an audit table has zero rows (first run)", async () => {
  await resetAuditTables();

  const findings = await computeCurrentFindings();
  assert.deepEqual(findings, []);
});
