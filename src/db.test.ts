import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma, assertSafeDatabase } from "./db";

const NEON_URL = "postgresql://user:pass@ep-falso-123.eu-central-1.aws.neon.tech/neondb?sslmode=require";

function withSeoEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.SEO_ENV;
  if (value === undefined) delete process.env.SEO_ENV;
  else process.env.SEO_ENV = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.SEO_ENV;
    else process.env.SEO_ENV = previous;
  }
}

test("assertSafeDatabase lanza con SEO_ENV=test y una URL de neon.tech", () => {
  withSeoEnv("test", () => {
    assert.throws(() => assertSafeDatabase(NEON_URL), /neon\.tech/);
    assert.throws(() => assertSafeDatabase(NEON_URL.toUpperCase()), /neon\.tech/);
  });
});

test("assertSafeDatabase acepta la BD local con SEO_ENV=test", () => {
  withSeoEnv("test", () => {
    assert.doesNotThrow(() => assertSafeDatabase("postgresql://localhost/seo_agent_test?host=/tmp"));
    assert.doesNotThrow(() => assertSafeDatabase(undefined));
  });
});

test("assertSafeDatabase no bloquea Neon fuera del modo test", () => {
  withSeoEnv(undefined, () => {
    assert.doesNotThrow(() => assertSafeDatabase(NEON_URL));
  });
});

test("la suite de tests no está conectada a producción", () => {
  assert.equal(process.env.SEO_ENV, "test");
  assert.ok(!process.env.DATABASE_URL?.includes("neon.tech"));
  assert.ok(!process.env.DIRECT_URL?.includes("neon.tech"));
});

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

test("nuevas tablas existen", async () => {
  const counts = await Promise.all([
    prisma.searchConsolePageDaily.count(),
    prisma.searchConsoleQueryTyped.count(),
    prisma.searchConsoleSegmentDaily.count(),
    prisma.gscDataQuality.count(),
    prisma.urlInspection.count(),
    prisma.gscSitemapStatus.count(),
    prisma.productionProbeResult.count(),
    prisma.privateIncident.count(),
    prisma.analyticsLandingDaily.count(),
  ]);
  for (const count of counts) assert.equal(typeof count, "number");
});

// Crea y borra (por id) una fila de cada tabla nueva: comprueba que la migración
// SQL tiene todas las columnas del esquema de Prisma.
test("nuevas tablas aceptan todos sus campos", async () => {
  const date = new Date("2000-01-01T00:00:00Z");
  const page = `https://miwebdeboda.com/test-schema-${Math.random()}`;
  const metrics = { clicks: 1, impressions: 10, ctr: 0.1, position: 3.5, isFinal: true };

  const pageDaily = await prisma.searchConsolePageDaily.create({ data: { date, page, type: "web", ...metrics } });
  const queryTyped = await prisma.searchConsoleQueryTyped.create({
    data: { date, page, query: "mi web de boda", type: "image", isBrand: true, ...metrics },
  });
  const segment = await prisma.searchConsoleSegmentDaily.create({
    data: { date, page, device: "MOBILE", country: "esp", type: "web", ...metrics, position: null },
  });
  const quality = await prisma.gscDataQuality.create({
    data: {
      date,
      type: "web",
      dataset: `test-schema-${Math.random()}`,
      rowsReturned: 5,
      capped: false,
      pageTotalClicks: 40,
      queryDetailClicks: 30,
      anonymizedShare: 0.25,
      isFinal: false,
    },
  });
  const inspection = await prisma.urlInspection.create({
    data: {
      url: page,
      inSitemap: true,
      reason: "recent",
      verdict: "PASS",
      coverageState: "Submitted and indexed",
      indexingState: "INDEXING_ALLOWED",
      robotsTxtState: "ALLOWED",
      pageFetchState: "SUCCESSFUL",
      lastCrawlTime: date,
      googleCanonical: page,
      userCanonical: page,
      crawledAs: "MOBILE",
      richResultsVerdict: "PASS",
      richResultsItems: [{ richResultType: "FAQ" }],
      error: null,
    },
  });
  const sitemap = await prisma.gscSitemapStatus.create({
    data: {
      path: `${page}/sitemap.xml`,
      lastSubmitted: date,
      lastDownloaded: date,
      isPending: false,
      errors: 0,
      warnings: 2,
      contents: [{ type: "web", submitted: "10" }],
      raw: { path: page },
    },
  });
  const probe = await prisma.productionProbeResult.create({
    data: {
      url: page,
      kind: "sitemap",
      status: 200,
      finalUrl: page,
      metaRobots: "index,follow",
      xRobotsTag: null,
      canonical: page,
      ok: true,
      reason: null,
    },
  });
  const incident = await prisma.privateIncident.create({
    data: { urlHmac: `test-schema-${Math.random()}`, urlEncrypted: "iv:tag:data", sources: ["gsc:web", "probe"] },
  });
  const landing = await prisma.analyticsLandingDaily.create({
    data: { date, landingPage: page, channel: "Organic Search", sessions: 3, engagedSessions: 2, keyEvents: 1.5 },
  });

  try {
    assert.equal(pageDaily.isFinal, true);
    assert.equal(queryTyped.isBrand, true);
    assert.equal(segment.position, null);
    assert.equal(quality.anonymizedShare, 0.25);
    assert.deepEqual(inspection.richResultsItems, [{ richResultType: "FAQ" }]);
    assert.equal(sitemap.warnings, 2);
    assert.equal(probe.status, 200);
    assert.deepEqual(incident.sources, ["gsc:web", "probe"]);
    assert.equal(incident.resolvedAt, null);
    assert.ok(incident.lastSeenAt instanceof Date);
    assert.equal(landing.keyEvents, 1.5);
  } finally {
    await prisma.searchConsolePageDaily.delete({ where: { id: pageDaily.id } });
    await prisma.searchConsoleQueryTyped.delete({ where: { id: queryTyped.id } });
    await prisma.searchConsoleSegmentDaily.delete({ where: { id: segment.id } });
    await prisma.gscDataQuality.delete({ where: { id: quality.id } });
    await prisma.urlInspection.delete({ where: { id: inspection.id } });
    await prisma.gscSitemapStatus.delete({ where: { id: sitemap.id } });
    await prisma.productionProbeResult.delete({ where: { id: probe.id } });
    await prisma.privateIncident.delete({ where: { id: incident.id } });
    await prisma.analyticsLandingDaily.delete({ where: { id: landing.id } });
  }
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
