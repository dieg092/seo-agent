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
