// src/editorial/runEditorial.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { runEditorial } from "./runEditorial";
import { CRITERION_KEYS } from "./rubric";
import type { Runner } from "./evaluator";

const NOW = new Date("2026-11-18T10:00:00Z");
const BASE = "https://miwebdeboda.com";
const SLUGS = Array.from({ length: 14 }, (_, i) => `organizar-boda/art-${i}`);

beforeEach(async () => {
  await prisma.editorialScore.deleteMany({});
  await prisma.editorialCalibration.deleteMany({});
  await prisma.alert.deleteMany({ where: { type: { startsWith: "editorial-" } } });
  await prisma.searchConsolePageDaily.deleteMany({ where: { page: { startsWith: `${BASE}/blog/` } } });
  // art-0 es el que mejor funciona en GSC y art-7 el peor.
  await prisma.searchConsolePageDaily.createMany({
    data: SLUGS.map((s, i) => ({ date: new Date("2026-11-01"), page: `${BASE}/blog/${s}`, type: "web", clicks: 10, impressions: 1000, ctr: 0, position: 3 + i, isFinal: true })),
  });
});

/** Evaluador falso: la nota la decide `scoreOf(slug)` y cita una frase real del texto. */
function fakeRunner(scoreOf: (url: string) => number) {
  const calls: string[] = [];
  const runner: Runner = async ({ user }) => {
    const url = /URL: (\S+)/.exec(user)![1];
    calls.push(url);
    const score = scoreOf(url);
    return { summary: "s", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score, evidence: ["texto propio del artículo número"], note: "" }])) };
  };
  return { runner, calls };
}
const fetchHtml = async (url: string) => `<main><main><h1>T</h1><p>Este es el texto propio del artículo número ${idx(url)} y nada más.</p></main></main>`;
const listArticles = async () => [{ slug: "organizar-boda", url: `${BASE}/blog/organizar-boda` }, ...SLUGS.map((slug) => ({ slug, url: `${BASE}/blog/${slug}` }))];
const idx = (url: string) => Number(/art-(\d+)/.exec(url)?.[1] ?? 0);

test("calibra con GSC primero, luego evalúa un artículo por pasada y bloquea los flojos", async () => {
  const f = fakeRunner((u) => 8.8 - idx(u) * 0.3); // ordena como GSC: art-0 8.8 … art-13 4.9
  const n1 = await runEditorial({ now: NOW, runner: f.runner, fetchHtml, listArticles });
  assert.match(n1[0], /calibración: ok/);
  assert.equal(f.calls.length, 6, "6 referencias");
  assert.ok(!f.calls.some((u) => u.endsWith("/organizar-boda")), "las categorías no se evalúan");
  const cal = await prisma.editorialCalibration.findFirstOrThrow();
  assert.deepEqual((cal.references as { tier: string }[]).map((r) => r.tier), ["good", "good", "mid", "mid", "bad", "bad"]);

  const n2 = await runEditorial({ now: new Date(NOW.getTime() + 60_000), runner: f.runner, fetchHtml, listArticles });
  assert.equal(n2.length, 1);
  assert.match(n2[0], /editorial: organizar-boda\/art-\d+ /);
  assert.equal(f.calls.length, 7);
  const blocked = await prisma.editorialScore.findMany({ where: { decision: "block" } });
  assert.ok(blocked.every((b) => b.finalScore < 7));
  assert.ok(blocked.length >= 2);
});

test("con las notas al revés que GSC en 12 o más artículos, suspende y avisa", async () => {
  const f = fakeRunner((u) => 4 + idx(u) * 0.3); // al revés que GSC
  // Notas ya puestas al resto de artículos (de pasadas anteriores), también al revés.
  await prisma.editorialScore.createMany({
    data: SLUGS.map((slug, i) => ({ slug, url: `${BASE}/blog/${slug}`, contentHash: "x", kind: "routine", rubricVersion: "t", model: "t", score: 4 + i * 0.3, finalScore: 4 + i * 0.3, decision: "block", reason: "", criteria: {}, deterministic: {}, createdAt: new Date(NOW.getTime() - 86400_000) })),
  });
  const n1 = await runEditorial({ now: NOW, runner: f.runner, fetchHtml, listArticles });
  assert.match(n1[0], /calibración: inverted/);
  assert.equal(await prisma.alert.count({ where: { type: "editorial-calibration-inverted" } }), 1);
  const n2 = await runEditorial({ now: new Date(NOW.getTime() + 60_000), runner: f.runner, fetchHtml, listArticles });
  assert.match(n2[0], /suspendida/);
  assert.equal(f.calls.length, 6);
});

test("deriva: las referencias se reutilizan al mes y una que se mueve más de 1 punto suspende", async () => {
  let shift = 0;
  const f = fakeRunner((u) => 8.8 - idx(u) * 0.3 + (u.endsWith("art-0") ? shift : 0));
  await runEditorial({ now: NOW, runner: f.runner, fetchHtml, listArticles });
  shift = -1.5;
  const later = new Date(NOW.getTime() + 31 * 86400_000);
  const n = await runEditorial({ now: later, runner: f.runner, fetchHtml, listArticles });
  assert.match(n[0], /calibración: drift/);
  // Al día siguiente se recalibra con referencias nuevas (anclas nuevas) y vuelve a estar en verde.
  const n2 = await runEditorial({ now: new Date(later.getTime() + 25 * 3600_000), runner: f.runner, fetchHtml, listArticles });
  assert.match(n2[0], /calibración: ok/);
});

test("la validez se vigila en cada pasada: si las notas nuevas van al revés, suspende sin esperar al mes", async () => {
  const f = fakeRunner((u) => 8.8 - idx(u) * 0.3);
  await runEditorial({ now: NOW, runner: f.runner, fetchHtml, listArticles });
  await prisma.editorialScore.createMany({
    data: SLUGS.map((slug, i) => ({ slug, url: `${BASE}/blog/${slug}`, contentHash: "x", kind: "routine", rubricVersion: "t", model: "t", score: 4 + i * 0.3, finalScore: 4 + i * 0.3, decision: "block", reason: "", criteria: {}, deterministic: {}, createdAt: new Date(NOW.getTime() + 1000) })),
  });
  const n = await runEditorial({ now: new Date(NOW.getTime() + 60_000), runner: f.runner, fetchHtml, listArticles });
  assert.match(n[0], /suspendida: correlación nota–GSC -1/);
  assert.equal((await prisma.editorialCalibration.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).status, "inverted");
});
