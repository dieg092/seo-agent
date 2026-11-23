// src/editorial/budget.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { budgetToday, budgetedRunner, reserveCall, COMMUNITY_DAILY_RESERVE, EDITORIAL_DAILY_BACKGROUND, EDITORIAL_DAILY_GUARD } from "./budget";
import { EditorialDeferred, classifyModelError, madridDay, nextMadridMidnight, parseReset } from "./modelErrors";
import type { Runner } from "./evaluator";

const NOW = new Date("2026-11-19T12:46:51Z"); // 13:46 en Madrid

beforeEach(async () => {
  await prisma.editorialBudget.deleteMany({});
});

test("hora de reinicio del cupo en Madrid, con 5 min de margen; si no se entiende, 6 h", () => {
  assert.equal(parseReset("You've hit your 5-hour limit · resets 4:10pm (Europe/Madrid)", NOW)?.toISOString(), "2026-11-19T15:10:00.000Z");
  assert.equal(parseReset("resets at 9:00am", NOW)?.toISOString(), "2026-11-20T08:00:00.000Z", "ya pasó hoy: mañana");
  const q = classifyModelError(new Error("You've hit your limit · resets 4:10pm"), NOW);
  assert.equal(q.kind, "quota");
  assert.equal(q.retryAt?.toISOString(), "2026-11-19T15:15:00.000Z");
  assert.equal(classifyModelError(new Error("usage limit reached"), NOW).retryAt?.toISOString(), "2026-11-19T18:46:51.000Z");
  assert.equal(classifyModelError(new Error("connect ETIMEDOUT"), NOW).kind, "transient");
  assert.equal(classifyModelError(new Error("Unexpected token < in JSON"), NOW).kind, "invalid-output");
  assert.equal(classifyModelError(new Error("model not found"), NOW).kind, "permanent-model-error");
  assert.equal(madridDay(new Date("2026-11-19T23:30:00Z")), "2026-11-20");
  assert.equal(nextMadridMidnight(NOW).toISOString(), "2026-11-19T23:00:00.000Z");
});

test("presupuesto diario por tipo: fondo y guarda por separado, y vuelve a medianoche de Madrid", async () => {
  for (let i = 0; i < EDITORIAL_DAILY_BACKGROUND; i++) await reserveCall("background", NOW, { busy: () => false });
  await assert.rejects(reserveCall("background", NOW, { busy: () => false }), (e) => e instanceof EditorialDeferred && e.kind === "budget");
  for (let i = 0; i < EDITORIAL_DAILY_GUARD; i++) await reserveCall("guard", NOW);
  await assert.rejects(reserveCall("guard", NOW), EditorialDeferred);
  await reserveCall("background", new Date("2026-11-19T23:01:00Z"), { busy: () => false });
  assert.deepEqual((await budgetToday(NOW)), { background: EDITORIAL_DAILY_BACKGROUND, guard: EDITORIAL_DAILY_GUARD, quotaUntil: null });
});

test("un límite de cupo para a todos hasta el reinicio; la guarda no espera a Órbita, el fondo sí", async () => {
  let calls = 0;
  const limited: Runner = async () => {
    calls += 1;
    throw new Error("You've hit your limit · resets 4:10pm (Europe/Madrid)");
  };
  const r = budgetedRunner(limited, "guard", () => NOW);
  await assert.rejects(r({ system: "", user: "", schema: {} }), (e) => e instanceof EditorialDeferred && e.kind === "quota");
  await assert.rejects(budgetedRunner(limited, "guard", () => new Date(NOW.getTime() + 3600_000))({ system: "", user: "", schema: {} }), EditorialDeferred);
  assert.equal(calls, 1, "hasta el reinicio no se vuelve a llamar");
  const ok: Runner = async () => ({ ok: true }) as never;
  assert.deepEqual(await budgetedRunner(ok, "guard", () => new Date("2026-11-19T15:16:00Z"))({ system: "", user: "", schema: {} }), { ok: true });
  await assert.rejects(reserveCall("background", new Date("2026-11-19T16:00:00Z"), { busy: () => true }), (e) => e instanceof EditorialDeferred && e.kind === "busy");
  await reserveCall("guard", new Date("2026-11-19T16:00:00Z"));
});

test("comunidades tiene 2 llamadas reservadas aunque el fondo de hoy esté gastado, y también espera a Órbita", async () => {
  for (let i = 0; i < EDITORIAL_DAILY_BACKGROUND; i++) await reserveCall("background", NOW, { busy: () => false });
  await assert.rejects(reserveCall("background", NOW, { busy: () => false }), (e) => e instanceof EditorialDeferred && e.kind === "budget");
  await assert.rejects(reserveCall("community", NOW, { busy: () => true }), (e) => e instanceof EditorialDeferred && e.kind === "busy");
  for (let i = 0; i < COMMUNITY_DAILY_RESERVE; i++) await reserveCall("community", NOW, { busy: () => false });
  await assert.rejects(reserveCall("community", NOW, { busy: () => false }), (e) => e instanceof EditorialDeferred && e.kind === "budget");
  await assert.rejects(reserveCall("background", NOW, { busy: () => false }), EditorialDeferred);
});
