import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { computeCurrentFindings, syncOpportunities } from "./prioritize";

// resetAuditTables() below unscopedly deletes Opportunity (real, currently-open
// production findings) many times throughout this file, with no restore of its own —
// it treats Opportunity like the audit-result tables (cheap to regenerate by rerunning
// audits), but Opportunity also carries real status/history (open/resolved/reopened)
// synced over time. Back it up once before any test runs and restore it once after all
// tests finish, so the many resetAuditTables() calls in between are free to operate on
// an already-safely-backed-up table without permanently destroying real data.
let opportunityBackup: Awaited<ReturnType<typeof prisma.opportunity.findMany>> = [];

before(async () => {
  opportunityBackup = await prisma.opportunity.findMany({});
});

after(async () => {
  await prisma.opportunity.deleteMany({});
  if (opportunityBackup.length > 0) {
    await prisma.opportunity.createMany({ data: opportunityBackup });
  }
});

async function resetAuditTables() {
  await prisma.opportunity.deleteMany({});
  await prisma.sitemapAuditResult.deleteMany({});
  await prisma.robotsAuditResult.deleteMany({});
  await prisma.structuredDataAuditResult.deleteMany({});
  await prisma.performanceAuditResult.deleteMany({});
}

// Since computeCurrentFindings() now also reads real LinkSuggestion/
// SearchConsoleSnapshot rows unconditionally (Task 8), every test below
// that counts opportunities/findings WITHOUT filtering by source must
// isolate those two tables too — resetAuditTables() only ever cleared the
// 4 audit-result tables + Opportunity, which was correct before Task 8 but
// now leaves 140+ unrelated real findings bleeding into these assertions.
test("computeCurrentFindings + syncOpportunities creates an Opportunity from a real robots finding", async () => {
  await withEmptyLinkSuggestions(() =>
    withEmptySearchConsoleSnapshots(async () => {
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
    })
  );
});

test("running syncOpportunities twice with the same findings does not duplicate", async () => {
  await withEmptyLinkSuggestions(() =>
    withEmptySearchConsoleSnapshots(async () => {
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
    })
  );
});

test("an Opportunity is auto-resolved when its finding disappears, then reopened if it reappears", async () => {
  await withEmptyLinkSuggestions(() =>
    withEmptySearchConsoleSnapshots(async () => {
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
    })
  );
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

// The live database holds real production rows in LinkSuggestion (from Tasks 4-5)
// and SearchConsoleSnapshot (from the Fase 1 daily collector). Tests that need an
// empty table must back these up and restore them afterwards rather than deleting
// them permanently.
async function withEmptyLinkSuggestions<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.linkSuggestion.findMany({});
  await prisma.linkSuggestion.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.linkSuggestion.deleteMany({});
    if (backup.length > 0) {
      await prisma.linkSuggestion.createMany({ data: backup });
    }
  }
}

async function withEmptySearchConsoleSnapshots<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.searchConsoleSnapshot.findMany({});
  await prisma.searchConsoleSnapshot.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.searchConsoleSnapshot.deleteMany({});
    if (backup.length > 0) {
      await prisma.searchConsoleSnapshot.createMany({ data: backup });
    }
  }
}

test("computeCurrentFindings returns no findings when an audit table has zero rows (first run)", async () => {
  await resetAuditTables();

  await withEmptyLinkSuggestions(() =>
    withEmptySearchConsoleSnapshots(async () => {
      const findings = await computeCurrentFindings();
      assert.deepEqual(findings, []);
    })
  );
});

test("computeCurrentFindings includes open LinkSuggestion rows as internal-link findings", async () => {
  await resetAuditTables();

  await withEmptyLinkSuggestions(async () => {
    await prisma.linkSuggestion.create({
      data: {
        sourceSlug: "a",
        targetSlug: "b",
        similarity: 0.5,
        stableKey: `test-link-${Math.random()}`,
        status: "open",
      },
    });

    const findings = await computeCurrentFindings();
    const linkFindings = findings.filter((f) => f.source === "internalLinking");
    assert.equal(linkFindings.length, 1);
  });

  await resetAuditTables();
});

test("computeCurrentFindings includes cannibalization findings computed from recent SearchConsoleSnapshot rows", async () => {
  await resetAuditTables();

  await withEmptySearchConsoleSnapshots(async () => {
    const today = new Date();
    await prisma.searchConsoleSnapshot.create({
      data: { date: today, page: "/blog/a", query: "misma query", clicks: 1, impressions: 10, ctr: 0.1, position: 8 },
    });
    await prisma.searchConsoleSnapshot.create({
      data: { date: today, page: "/blog/b", query: "misma query", clicks: 1, impressions: 10, ctr: 0.1, position: 12 },
    });

    const findings = await computeCurrentFindings();
    const contentFindings = findings.filter((f) => f.findingType === "content-cannibalization");
    assert.equal(contentFindings.length, 1);
  });

  await resetAuditTables();
});
