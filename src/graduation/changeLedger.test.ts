// src/graduation/changeLedger.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { reconcileChanges, measureChanges, metricFor, advanceReverts } from "./changeLedger";
import { regressionKey } from "../revert/regression";

const PAGE = "https://miwebdeboda.com/blog/a/b";
const T1 = "aaaa1111-0000-4000-8000-000000000001";
const T2 = "bbbb2222-0000-4000-8000-000000000002";
const DAY = 24 * 3600_000;
const D0 = new Date("2026-09-01T12:00:00Z");
const alerts: string[] = [];
const alert = async (a: { type: string }) => void alerts.push(a.type);

async function link(id: string, over: Record<string, unknown> = {}) {
  await prisma.seoTaskLink.create({
    data: {
      opportunityId: "o",
      stableKey: `k-${id}`,
      orbitaTaskId: id,
      findingType: "low-ctr",
      operation: "meta-title-description",
      page: PAGE,
      lane: "technical",
      autonomy: "A1",
      contract: { publishPolicy: "auto-merge-if-green" },
      taskStatus: "done",
      expiresAt: new Date(D0.getTime() + 30 * DAY),
      closedAt: D0,
      closeReason: "done",
      ...over,
    },
  });
}

beforeEach(async () => {
  alerts.length = 0;
  await prisma.seoChange.deleteMany({});
  await prisma.seoTaskLink.deleteMany({});
  await prisma.deployEvent.deleteMany({});
  await prisma.opportunity.deleteMany({ where: { source: "seo-measurement" } });
});

test("registro: tarea A1 terminada → cambio; despliegue = primer DeployEvent con su id8; idempotente", async () => {
  await link(T1);
  await link(T2, { contract: { publishPolicy: "pr-only" } });
  await prisma.deployEvent.create({ data: { commitSha: "later", deployedAt: new Date(D0.getTime() + 2 * DAY), seoChangeIds: ["aaaa1111"] } });
  await prisma.deployEvent.create({ data: { commitSha: "first", deployedAt: new Date(D0.getTime() + DAY), seoChangeIds: ["zzz", "aaaa1111"] } });
  await reconcileChanges(new Date(D0.getTime() + 3 * DAY), alert);
  await reconcileChanges(new Date(D0.getTime() + 3 * DAY), alert);
  const all = await prisma.seoChange.findMany();
  assert.equal(all.length, 1, "solo la A1 con fusión automática, una vez");
  assert.equal(all[0].status, "deployed");
  assert.equal(all[0].deployCommitSha, "first");
});

test("sin despliegue a las 24 h: un aviso, una sola vez; id8 repetido: ambiguo", async () => {
  await link(T1);
  await reconcileChanges(new Date(D0.getTime() + 2 * DAY), alert);
  await reconcileChanges(new Date(D0.getTime() + 3 * DAY), alert);
  assert.deepEqual(alerts, ["seo-change-no-deploy"]);
  await link("aaaa1111-ffff-4000-8000-000000000009");
  await prisma.seoChange.updateMany({ data: { alertedAt: null } });
  await reconcileChanges(new Date(D0.getTime() + 3 * DAY), alert);
  assert.equal((await prisma.seoChange.findUnique({ where: { orbitaTaskId: T1 } }))?.status, "ambiguous");
});

/** GSC falso: CTR antes y después del despliegue. */
const sumFor = (beforeCtr: number, afterCtr: number, laterCtr = afterCtr) => async (_p: string, start: Date) => {
  const dep = D0.getTime() + DAY;
  const ctr = start.getTime() < dep ? beforeCtr : start.getTime() < dep + 10 * DAY ? afterCtr : laterCtr;
  return { clicks: Math.round(2000 * ctr), impressions: 2000, position: 4 };
};

async function deployed() {
  await link(T1);
  await prisma.deployEvent.create({ data: { commitSha: "first", deployedAt: new Date(D0.getTime() + DAY), seoChangeIds: ["aaaa1111"] } });
  await reconcileChanges(new Date(D0.getTime() + 2 * DAY), alert);
}

test("medición: espera a la ventana; un positivo se guarda", async () => {
  await deployed();
  assert.deepEqual(await measureChanges(new Date(D0.getTime() + 10 * DAY), { sum: sumFor(0.02, 0.05), alert }), []);
  await measureChanges(new Date(D0.getTime() + 40 * DAY), { sum: sumFor(0.02, 0.05), alert });
  const c = await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } });
  assert.equal(c.status, "measured");
  assert.equal(c.outcome, "positive");
  assert.equal(metricFor("meta-title-description"), "ctr");
});

test("negativo: no revierte a la primera; si la segunda ventana lo confirma, abre la reversión exacta", async () => {
  await deployed();
  await measureChanges(new Date(D0.getTime() + 40 * DAY), { sum: sumFor(0.05, 0.01), alert });
  let c = await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } });
  assert.equal(c.status, "negative-unconfirmed");
  assert.equal(await prisma.opportunity.count({ where: { stableKey: regressionKey("aaaa1111") } }), 0);
  await measureChanges(new Date(D0.getTime() + 60 * DAY), { sum: sumFor(0.05, 0.01), alert });
  c = await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } });
  assert.equal(c.status, "negative-confirmed", "todavía no está revertido: solo confirmado");
  const o = await prisma.opportunity.findUniqueOrThrow({ where: { stableKey: regressionKey("aaaa1111") } });
  assert.equal(o.operation, "revert-change");
  assert.equal(o.state, "queued");
  assert.ok(alerts.includes("seo-change-negative"));
});

test("negativo que no se confirma: medido, sin reversión", async () => {
  await deployed();
  await measureChanges(new Date(D0.getTime() + 40 * DAY), { sum: sumFor(0.05, 0.01, 0.05), alert });
  await measureChanges(new Date(D0.getTime() + 60 * DAY), { sum: sumFor(0.05, 0.01, 0.05), alert });
  const c = await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } });
  assert.equal(c.status, "measured");
  assert.equal(await prisma.opportunity.count({ where: { stableKey: regressionKey("aaaa1111") } }), 0);
});

test("otro cambio en la misma página dentro de la ventana: no evaluable", async () => {
  await deployed();
  await link(T2);
  await prisma.deployEvent.create({ data: { commitSha: "second", deployedAt: new Date(D0.getTime() + 10 * DAY), seoChangeIds: ["bbbb2222"] } });
  await reconcileChanges(new Date(D0.getTime() + 11 * DAY), alert);
  await measureChanges(new Date(D0.getTime() + 40 * DAY), { sum: sumFor(0.02, 0.05), alert });
  assert.equal((await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } })).status, "not-evaluable");
});

test("reversión: confirmado → PR abierto → fusionada → verificada solo cuando un despliegue la contiene", async () => {
  await deployed();
  await measureChanges(new Date(D0.getTime() + 40 * DAY), { sum: sumFor(0.05, 0.01), alert });
  await measureChanges(new Date(D0.getTime() + 60 * DAY), { sum: sumFor(0.05, 0.01), alert });
  let revert: string | null = null;
  const shipped = new Set<string>();
  const gitOps = { revertSha: () => revert, contains: (_a: string, d: string) => shipped.has(d) };
  const status = async () => (await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } })).status;
  const at = (d: number) => new Date(D0.getTime() + d * DAY);

  await advanceReverts(at(61), gitOps);
  assert.equal(await status(), "negative-confirmed");
  await prisma.opportunity.update({ where: { stableKey: regressionKey("aaaa1111") }, data: { detail: { changeId: "aaaa1111", prUrl: "https://github.com/x/y/pull/1" } } });
  await advanceReverts(at(61), gitOps);
  assert.equal(await status(), "revert-open");
  revert = "rev1";
  await advanceReverts(at(62), gitOps);
  assert.equal(await status(), "revert-merged", "fusionada pero sin desplegar");
  await prisma.deployEvent.create({ data: { commitSha: "dep-old", deployedAt: at(62), seoChangeIds: [] } });
  await advanceReverts(at(62), gitOps);
  assert.equal(await status(), "revert-merged", "un despliegue que no la trae no cuenta");
  shipped.add("dep-new");
  await prisma.deployEvent.create({ data: { commitSha: "dep-new", deployedAt: at(63), seoChangeIds: [] } });
  await advanceReverts(at(63), gitOps);
  const c = await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } });
  assert.equal(c.status, "revert-verified");
  assert.equal(c.revertSha, "rev1");
  assert.equal(c.revertVerifiedAt?.toISOString(), at(63).toISOString());
});

test("reversión que falla: revert-failed", async () => {
  await deployed();
  await measureChanges(new Date(D0.getTime() + 40 * DAY), { sum: sumFor(0.05, 0.01), alert });
  await measureChanges(new Date(D0.getTime() + 60 * DAY), { sum: sumFor(0.05, 0.01), alert });
  await prisma.opportunity.update({ where: { stableKey: regressionKey("aaaa1111") }, data: { detail: { changeId: "aaaa1111", failed: "la reversión choca con cambios posteriores" } } });
  await advanceReverts(new Date(D0.getTime() + 61 * DAY), { revertSha: () => null, contains: () => false });
  assert.equal((await prisma.seoChange.findUniqueOrThrow({ where: { orbitaTaskId: T1 } })).status, "revert-failed");
});
