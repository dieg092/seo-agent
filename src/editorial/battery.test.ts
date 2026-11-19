// src/editorial/battery.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { batteryDue, batteryPasses, batteryState, runBattery } from "./battery";
import { BATTERY_CASES } from "./fixtures/validationCases";
import { CRITERION_KEYS } from "./rubric";
import type { Runner } from "./evaluator";

const NOW = new Date("2026-11-20T12:00:00Z");
const SITE = "https://miwebdeboda.com";
const reply = (score: number, quote: string) => ({ summary: "", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score, evidence: [quote], note: "" }])) });
const QUOTE = "Hacer la lista de invitados es lo primero";

beforeEach(async () => {
  await prisma.editorialBattery.deleteMany({});
});

test("la batería tiene 20 casos, 10 críticos, y cada uno cambia el artículo base", () => {
  assert.equal(BATTERY_CASES.length, 20);
  assert.equal(BATTERY_CASES.filter((c) => c.critical).length, 10);
  assert.equal(new Set(BATTERY_CASES.map((c) => c.id)).size, 20);
});

test("aprobada: todos los críticos y ≥ 90 %; un crítico escapado la suspende", () => {
  const ok = BATTERY_CASES.map((c, i) => ({ critical: c.critical, detected: c.critical || i % 10 !== 0 }));
  assert.equal(batteryPasses(ok).passed, true);
  assert.equal(batteryPasses(ok.map((r, i) => (i === 4 ? { ...r, detected: false } : r))).passed, false);
});

test("un evaluador que premia lo largo deja pasar contradicciones: la batería no pasa y se reintenta al día siguiente", async () => {
  // nota según el número de secciones: añadir cualquier cosa sube medio punto
  const naive: Runner = async ({ user }) => reply(6 + (user.match(/\n## /g)?.length ?? 0) * 0.5, QUOTE);
  const note = await runBattery(naive, NOW, SITE);
  assert.match(note, /no pasa/);
  assert.match(note, /contradice-confirmacion/);
  assert.equal((await batteryState(NOW)).status, "failed");
  assert.equal(await batteryDue(new Date(NOW.getTime() + 3600_000)), false);
  assert.equal(await batteryDue(new Date(NOW.getTime() + 25 * 3600_000)), true);
});

test("un evaluador que no premia los defectos la aprueba; vale 30 días", async () => {
  const strict: Runner = async () => reply(7.5, QUOTE);
  const note = await runBattery(strict, NOW, SITE);
  assert.match(note, /pasa \(20\/20\)/);
  assert.equal((await batteryState(NOW)).status, "ok");
  assert.equal(await batteryDue(new Date(NOW.getTime() + 29 * 86400_000)), false);
  assert.equal((await batteryState(new Date(NOW.getTime() + 31 * 86400_000))).status, "stale");
});
