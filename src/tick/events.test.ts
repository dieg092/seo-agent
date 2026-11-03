import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEvents, nextState, type TaskSnap } from "./events";

const snap = (o: Partial<TaskSnap>): TaskSnap => ({ id: "t1", title: "SEO fase 2 · x", status: "todo", labels: ["seo-fase2"], lastNote: null, jobStatus: "pending", ...o });

test("tarea con fusion-manual terminada sin fusionar: lista para revisión", () => {
  const prev = nextState([snap({ status: "in_progress", labels: ["seo-fase2", "fusion-manual"] })]);
  const ev = computeEvents(prev, [snap({ status: "done", labels: ["seo-fase2", "fusion-manual"], lastNote: "🤖 … no fusionada: la tarea lleva «fusion-manual»: …", jobStatus: "done" })]);
  assert.deepEqual(ev.map((e) => e.kind), ["lista-revision"]);
});

test("fusionada en main con fusion-manual: alerta de fusión inesperada", () => {
  const ev = computeEvents({}, [snap({ status: "done", labels: ["seo-fase2", "fusion-manual"], lastNote: "fusionada en main (abc)" })]);
  assert.ok(ev.some((e) => e.kind === "fusion-inesperada"));
});

test("commits de otras tareas: rama bloqueada", () => {
  const ev = computeEvents({}, [snap({ status: "done", lastNote: "no fusionada: la rama traía 2 commit(s) de otras tareas sin fusionar" })]);
  assert.deepEqual(ev.map((e) => e.kind), ["rama-bloqueada"]);
});

test("bloqueada y fallo avisan una sola vez", () => {
  const curr = [snap({ status: "blocked", lastNote: "falla el lint", jobStatus: "failed" })];
  const first = computeEvents({}, curr);
  assert.deepEqual(first.map((e) => e.kind).sort(), ["bloqueada", "fallo"]);
  assert.deepEqual(computeEvents(nextState(curr), curr), []);
});

test("las tareas que no son SEO no generan avisos", () => {
  assert.deepEqual(computeEvents({}, [snap({ labels: ["creada por la IA"], status: "blocked" })]), []);
});

test("reconoce la nota con rango de commits de la tarea", () => {
  const ev = computeEvents({}, [snap({ status: "done", labels: ["seo-fase2", "fusion-manual"], lastNote: "rama ia/x · no fusionada (commits de esta tarea: aaaa1111..bbbb2222): la tarea lleva «fusion-manual»: …" })]);
  assert.deepEqual(ev.map((e) => e.kind), ["lista-revision"]);
});

test("CI de main: avisa de fallo, cancelación o ausencia prolongada, una vez por commit", async () => {
  const { mainCiEvent } = await import("./events");
  assert.equal(mainCiEvent(null, { sha: "a1", conclusion: "success", ageMinutes: 50 }), null);
  assert.match(mainCiEvent(null, { sha: "a1", conclusion: "failure", ageMinutes: 50 })!.detail, /fallado/);
  assert.match(mainCiEvent(null, { sha: "a1", conclusion: "cancelled", ageMinutes: 50 })!.detail, /cancel/);
  assert.equal(mainCiEvent(null, { sha: "a1", conclusion: null, ageMinutes: 30 }), null);
  assert.match(mainCiEvent(null, { sha: "a1", conclusion: null, ageMinutes: 130 })!.detail, /2 h/);
  assert.equal(mainCiEvent("a1", { sha: "a1", conclusion: "failure", ageMinutes: 50 }), null);
});
