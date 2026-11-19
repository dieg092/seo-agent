// src/editorial/pilot.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { advancePilots, pilotHasRoom, pilotReport, pilotVerdict, reservePilot, PILOT_MAX_DAYS } from "./pilot";
import { batteryKey } from "./battery";

const BASE = "https://miwebdeboda.com/blog";
const NOW = new Date("2027-01-01T12:00:00Z");
const DAY = 86400_000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY);
const alerts: { type: string; subject: string }[] = [];
const alert = async (a: { type: string; subject: string; body: string }) => {
  alerts.push(a);
  await prisma.alert.create({ data: { ...a, createdAt: NOW } });
};
const change = (id: string, over: Record<string, unknown> = {}) => ({ orbitaTaskId: id, changeId8: id.slice(0, 8), stableKey: `k-${id}`, findingType: "editorial-low-score", operation: "content-improve", page: `${BASE}/a/${id}`, status: "pending-deploy", ...over });

beforeEach(async () => {
  alerts.length = 0;
  await prisma.editorialPilot.deleteMany({});
  await prisma.seoChange.deleteMany({});
  await prisma.editorialBattery.deleteMany({});
  await prisma.alert.deleteMany({ where: { type: "editorial-pilot-report" } });
});

test("reserva: idempotente, dos a la vez solo se queda una plaza si el espaciado lo impide", async () => {
  const [a, b] = await Promise.all([reservePilot({ orbitaTaskId: "t1", page: `${BASE}/a/1` }, NOW), reservePilot({ orbitaTaskId: "t2", page: `${BASE}/a/2` }, NOW)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, JSON.stringify([a, b]));
  assert.equal(await prisma.editorialPilot.count({ where: { state: "reserved" } }), 1);
  const winner = a.ok ? "t1" : "t2";
  assert.deepEqual(await reservePilot({ orbitaTaskId: winner, page: `${BASE}/a/${winner === "t1" ? 1 : 2}` }, at(1)), { ok: true, note: "plaza del piloto ya reservada" });
});

test("página con otro cambio SEO reciente: no hay plaza para ella", async () => {
  await prisma.seoChange.create({ data: change("otro", { page: `${BASE}/a/1`, status: "deployed", deployedAt: at(-20) }) });
  const r = await reservePilot({ orbitaTaskId: "t1", page: `${BASE}/a/1` }, NOW);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /otro cambio SEO en los últimos 56 días/);
});

test("ciclo: reservado → en observación al desplegar → cerrado con el resultado medido", async () => {
  await reservePilot({ orbitaTaskId: "t1", page: `${BASE}/a/t1` }, NOW);
  await prisma.seoChange.create({ data: change("t1", { status: "deployed", deployedAt: at(1) }) });
  await advancePilots(at(1));
  assert.equal((await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: "t1" } })).state, "observing");
  await prisma.seoChange.update({ where: { orbitaTaskId: "t1" }, data: { status: "measured", outcome: "positive" } });
  await advancePilots(at(40));
  const p = await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: "t1" } });
  assert.equal(p.state, "positive");
  assert.ok(p.closedAt);
});

test("reserva sin fusionar en 24 h se libera y la tarea puede volver a pedir plaza", async () => {
  await reservePilot({ orbitaTaskId: "t1", page: `${BASE}/a/t1` }, NOW);
  await advancePilots(at(0.5));
  assert.equal((await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: "t1" } })).state, "reserved");
  await advancePilots(at(2));
  assert.equal((await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: "t1" } })).state, "released");
  assert.ok(await pilotHasRoom(at(2)), "una reserva liberada no cuenta para el espaciado");
  assert.equal((await reservePilot({ orbitaTaskId: "t1", page: `${BASE}/a/t1` }, at(3))).ok, true);
});

test("sin datos a los 90 días: inconcluso y la plaza vuelve a quedar libre", async () => {
  await prisma.editorialPilot.create({ data: { orbitaTaskId: "t1", page: `${BASE}/a/t1`, state: "observing", reservedAt: at(-100), deployedAt: at(-PILOT_MAX_DAYS - 1) } });
  await prisma.editorialPilot.create({ data: { orbitaTaskId: "t2", page: `${BASE}/a/t2`, state: "observing", reservedAt: at(-30), deployedAt: at(-29) } });
  assert.equal(await pilotHasRoom(NOW), false, "lleno");
  await advancePilots(NOW);
  assert.equal((await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: "t1" } })).state, "inconclusive");
  assert.equal(await pilotHasRoom(NOW), true);
});

test("negativo confirmado: cierra el piloto como negativo y pausa las reservas", async () => {
  await prisma.editorialPilot.create({ data: { orbitaTaskId: "t1", page: `${BASE}/a/t1`, state: "observing", reservedAt: at(-60), deployedAt: at(-59) } });
  await prisma.seoChange.create({ data: change("t1", { status: "negative-confirmed", deployedAt: at(-59), outcome: "negative" }) });
  await advancePilots(NOW);
  assert.equal((await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: "t1" } })).state, "negative");
  assert.equal(await pilotHasRoom(NOW), false);
  assert.match(((await reservePilot({ orbitaTaskId: "t9", page: `${BASE}/a/t9` }, NOW)) as { reason: string }).reason, /en pausa/);
});

test("veredicto: favorable solo con volumen y sin negativos pendientes; perjudicial si pesan más los negativos", () => {
  const n = (s: string, k: number) => Array.from({ length: k }, () => ({ state: s }));
  assert.equal(pilotVerdict([...n("positive", 8), ...n("neutral", 2), ...n("negative", 1)], 0).verdict, "favorable");
  assert.equal(pilotVerdict([...n("positive", 8), ...n("neutral", 2), ...n("negative", 1)], 1).verdict, "insuficiente");
  assert.equal(pilotVerdict([...n("positive", 3), ...n("inconclusive", 9)], 0).verdict, "insuficiente");
  assert.equal(pilotVerdict([...n("positive", 1), ...n("negative", 2)], 0).verdict, "perjudicial");
});

test("informe a los 180 días, uno por periodo; si es perjudicial, pausa hasta que cambie la configuración", async () => {
  await prisma.editorialPilot.createMany({
    data: [
      { orbitaTaskId: "t1", page: `${BASE}/a/1`, state: "negative", reservedAt: at(-200), deployedAt: at(-199), closedAt: at(-150) },
      { orbitaTaskId: "t2", page: `${BASE}/a/2`, state: "negative", reservedAt: at(-180), deployedAt: at(-179), closedAt: at(-120) },
    ],
  });
  await prisma.editorialBattery.create({ data: { configKey: batteryKey(), passed: true, detected: 20, total: 20, criticalMissed: 0, detail: {}, createdAt: at(-10) } });
  assert.match((await pilotReport(NOW, alert))[0], /informe perjudicial/);
  assert.deepEqual(await pilotReport(at(1), alert), [], "uno por periodo");
  assert.equal(alerts.length, 1);
  await prisma.editorialBattery.create({ data: { configKey: batteryKey(), passed: true, detected: 20, total: 20, criticalMissed: 0, detail: {}, createdAt: at(1) } });
  assert.equal(await pilotHasRoom(at(2)), false, "misma configuración: sigue en pausa");
  await prisma.editorialBattery.updateMany({ where: { createdAt: { lt: NOW } }, data: { configKey: "configuracion-anterior" } });
  assert.equal(await pilotHasRoom(at(2)), true, "configuración nueva con batería aprobada: se reanuda");
});
