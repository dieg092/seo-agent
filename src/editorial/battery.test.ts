// src/editorial/battery.test.ts (BD de pruebas)
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { batteryDue, batteryPasses, batteryState, earlyVerdict, modelOrder, stepBattery, MAX_QUALITY_ATTEMPTS, MAX_QUOTA_HITS, RUN_MAX_DAYS } from "./battery";
import { BASE_ARTICLE, BATTERY_CASES, BATTERY_FACTS } from "./fixtures/validationCases";
import { deterministicBlock } from "./paired";
import { CRITERION_KEYS } from "./rubric";
import type { Runner } from "./evaluator";
import { EDITORIAL_DAILY_BACKGROUND } from "./budget";

const NOW = new Date("2026-11-20T12:00:00Z");
const SITE = "https://miwebdeboda.com";
const H = 3600_000;
const at = (h: number) => new Date(NOW.getTime() + h * H);
const reply = (score: number) => ({ summary: "", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score, evidence: ["Hacer la lista de invitados es lo primero"], note: "" }])) });
const alerts: string[] = [];
const alert = async (a: { type: string; subject: string; body: string }) => {
  alerts.push(a.subject);
  await prisma.alert.create({ data: a });
};
const MODEL_CASES = BATTERY_CASES.filter((c) => !deterministicBlock(BASE_ARTICLE, c.head, c.id, BATTERY_FACTS)).length;

function counting(r: (user: string) => number) {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const runner: Runner = async ({ user }) => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((res) => setTimeout(res, 1));
    active -= 1;
    return reply(r(user));
  };
  return { runner, calls: () => calls, maxActive: () => maxActive };
}
beforeEach(async () => {
  alerts.length = 0;
  await prisma.editorialBattery.deleteMany({});
  await prisma.editorialBatteryRun.deleteMany({});
  await prisma.editorialBatterySample.deleteMany({});
  await prisma.editorialBatteryCaseResult.deleteMany({});
  await prisma.editorialBudget.deleteMany({});
  await prisma.alert.deleteMany({ where: { type: "editorial-disabled" } });
});

test("22 casos, 12 críticos; los de cifras se resuelven sin llamar al modelo; críticos primero", () => {
  assert.equal(BATTERY_CASES.length, 22);
  assert.equal(BATTERY_CASES.filter((c) => c.critical).length, 12);
  assert.equal(BATTERY_CASES.length - MODEL_CASES, 6, "los 6 casos de cifras son deterministas (también con el dato admitido mal usado)");
  const order = modelOrder(BATTERY_CASES);
  assert.ok(order.slice(0, 10).every((c) => c.critical));
});

test("umbral y corte temprano: un crítico escapado o no poder llegar al 90 % decide ya", () => {
  const ok = BATTERY_CASES.map((c, i) => ({ critical: c.critical, detected: c.critical || i % 10 !== 0 }));
  assert.equal(batteryPasses(ok).passed, true);
  assert.equal(earlyVerdict([{ critical: true, detected: false }], 20), "failed");
  assert.equal(earlyVerdict([{ critical: false, detected: false }, { critical: false, detected: false }], 20), null);
  assert.equal(earlyVerdict([0, 1, 2].map(() => ({ critical: false, detected: false })), 20), "failed");
});

test("evaluador estricto: pasa con una llamada cada vez y las mínimas (2 de la base + 2 por caso con modelo)", async () => {
  const r = counting(() => 7.5);
  const note = await stepBattery(r.runner, NOW, SITE, { unbudgeted: true, alert });
  assert.match(note, /pasa \(22\/22\)/);
  assert.equal(r.calls(), 2 + 2 * MODEL_CASES);
  assert.equal(r.maxActive(), 1, "nunca dos llamadas a la vez");
  assert.equal((await batteryState(NOW)).status, "ok");
  assert.equal(await batteryDue(at(24 * 29)), false);
  assert.equal(await batteryDue(at(24 * 31)), true, "a los 30 días se renueva");
});

test("se corta a mitad y se reanuda sin repetir ninguna llamada", async () => {
  let budget = 7;
  let calls = 0;
  const flaky: Runner = async () => {
    if (budget-- <= 0) throw new Error("claude salió con 1: You've hit your 5-hour limit · resets 4:10pm (Europe/Madrid)");
    calls += 1;
    return reply(7.5);
  };
  const n1 = await stepBattery(flaky, NOW, SITE, { unbudgeted: true, alert });
  assert.match(n1, /cupo del modelo agotado, sigue a partir de 2026-11-20T15:15:00/);
  assert.equal(await batteryDue(at(1)), false, "no se reintenta antes del reinicio");
  assert.equal((await batteryState(at(1))).status, "running");
  budget = 1000;
  const n2 = await stepBattery(flaky, at(4), SITE, { unbudgeted: true, alert });
  assert.match(n2, /pasa/);
  assert.equal(calls, 2 + 2 * MODEL_CASES, "ninguna respuesta pedida dos veces");
});

test("si el artículo base tiene algún criterio < 4, la batería no vale aunque bloquee todo", async () => {
  const floorLow: Runner = async () => ({ summary: "", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score: k === "enlazado" ? 2 : 7.5, evidence: ["Hacer la lista de invitados es lo primero"], note: "" }])) });
  const note = await stepBattery(floorLow, NOW, SITE, { unbudgeted: true, alert });
  assert.match(note, /no vale \(el artículo base tiene criterios por debajo de 4: enlazado/);
  assert.notEqual((await batteryState(NOW)).status, "ok");
});

test("evaluador que premia lo largo: no pasa, corta pronto, reintenta con espera y a la 3.ª queda desactivada (terminal)", async () => {
  const naive = counting((user) => 6 + (user.match(/\n## /g)?.length ?? 0) * 0.5);
  const n1 = await stepBattery(naive.runner, NOW, SITE, { unbudgeted: true, alert });
  assert.match(n1, /no pasa \(intento 1\/3/);
  assert.ok(naive.calls() < 2 + 2 * MODEL_CASES, "corta en el primer crítico que se escapa");
  assert.equal(await batteryDue(at(5)), false, "espera 6 h");
  assert.equal(await batteryDue(at(6.1)), true);
  assert.match(await stepBattery(naive.runner, at(6.1), SITE, { unbudgeted: true, alert }), /intento 2\/3/);
  assert.equal(await batteryDue(at(17)), false, "espera 12 h");
  const n3 = await stepBattery(naive.runner, at(18.2), SITE, { unbudgeted: true, alert });
  assert.match(n3, new RegExp(`${MAX_QUALITY_ATTEMPTS}.ª vez, IA editorial desactivada`));
  assert.equal((await batteryState(at(19))).status, "disabled");
  assert.equal(await batteryDue(at(24 * 365)), false, "terminal: nunca más con esta configuración");
  const before = naive.calls();
  assert.match(await stepBattery(naive.runner, at(48), SITE, { unbudgeted: true, alert }), /desactivada/);
  assert.equal(naive.calls(), before, "un estado terminal no llama al modelo");
  assert.equal(alerts.length, 1, "un solo aviso");
});

test("errores técnicos: esperas de 1, 2 y 4 h y, al cuarto seguido, desactivada", async () => {
  const broken: Runner = async () => {
    throw new Error("connect ETIMEDOUT");
  };
  const waits: number[] = [];
  let t = NOW;
  for (let i = 0; i < 6; i++) {
    const note = await stepBattery(broken, t, SITE, { unbudgeted: true, alert });
    if (/desactivada/.test(note)) break;
    const run = await prisma.editorialBatteryRun.findFirstOrThrow({ where: { status: "running" } });
    waits.push((run.nextAttemptAt!.getTime() - t.getTime()) / H);
    t = run.nextAttemptAt!;
  }
  assert.deepEqual(waits, [1, 2, 4]);
  assert.equal((await batteryState(t)).status, "disabled");
  assert.equal(alerts.length, 1);
});

test("demasiados límites de cupo en una ejecución o 21 días sin terminar: desactivada por recursos", async () => {
  const quota: Runner = async () => {
    throw new Error("You've hit your limit · resets 4:10pm (Europe/Madrid)");
  };
  let t = NOW;
  let note = "";
  for (let i = 0; i <= MAX_QUOTA_HITS + 1; i++) {
    note = await stepBattery(quota, t, SITE, { unbudgeted: true, alert });
    t = new Date(t.getTime() + 25 * H);
  }
  assert.match(note, /desactivada/);
  await prisma.editorialBatteryRun.deleteMany({});
  await prisma.alert.deleteMany({ where: { type: "editorial-disabled" } });
  await prisma.editorialBatteryRun.create({ data: { configKey: (await import("./battery")).batteryKey(), attempt: 1, status: "running", startedAt: new Date(NOW.getTime() - (RUN_MAX_DAYS + 1) * 24 * H) } });
  assert.match(await stepBattery(quota, NOW, SITE, { unbudgeted: true, alert }), /21 días sin terminar/);
});

test("con presupuesto: como mucho 14 llamadas de fondo al día; sigue al día siguiente hasta terminar", async () => {
  const r = counting(() => 7.5);
  const note1 = await stepBattery(r.runner, NOW, SITE, { busy: () => false, alert });
  assert.match(note1, /presupuesto de hoy gastado/);
  assert.equal(r.calls(), EDITORIAL_DAILY_BACKGROUND);
  let t = NOW;
  let note = note1;
  for (let day = 1; day <= 5 && !/pasa/.test(note); day++) {
    t = new Date(NOW.getTime() + day * 24 * H);
    note = await stepBattery(r.runner, t, SITE, { busy: () => false, alert });
  }
  assert.match(note, /pasa/);
  assert.equal(r.calls(), 2 + 2 * MODEL_CASES, "ni una llamada repetida entre días");
});

test("Órbita ocupada: no llama y espera media hora sin contarlo como fallo", async () => {
  const r = counting(() => 7.5);
  assert.match(await stepBattery(r.runner, NOW, SITE, { busy: () => true, alert }), /Órbita usa el modelo/);
  assert.equal(r.calls(), 0);
  const run = await prisma.editorialBatteryRun.findFirstOrThrow({});
  assert.equal(run.transientFails, 0);
  assert.equal(run.quotaHits, 0);
  assert.equal(await batteryDue(at(0.4)), false);
  assert.equal(await batteryDue(at(0.6)), true);
});

test("bucle del puente acotado: con un evaluador roto, en ≤ 30 pasadas acaba en un estado final", async () => {
  const broken: Runner = async () => {
    throw new Error("connect ETIMEDOUT");
  };
  let t = NOW;
  for (let i = 0; i < 30; i++) {
    if (await batteryDue(t)) await stepBattery(broken, t, SITE, { unbudgeted: true, alert });
    t = new Date(t.getTime() + 0.5 * H);
  }
  assert.equal((await batteryState(t)).status, "disabled");
  assert.equal(await batteryDue(t), false);
});

after(async () => {
  await prisma.editorialBatteryRun.deleteMany({});
  await prisma.editorialBattery.deleteMany({});
});
