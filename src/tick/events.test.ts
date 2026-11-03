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
