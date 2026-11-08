// src/prioritization/lanes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectByLane, type LaneCandidate } from "./lanes";
import type { Lane } from "./catalog";

function many(lane: Lane, n: number, basePriority = 1): LaneCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ stableKey: `${lane}-${i}`, lane, priority: basePriority + i }));
}

function countByLane(list: LaneCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of list) out[c.lane] = (out[c.lane] ?? 0) + 1;
  return out;
}

test("cada carril se llena hasta su cupo diario: technical 4, content 3, strategy 2, links 1", () => {
  const { selected } = selectByLane([...many("technical", 10), ...many("content", 10), ...many("strategy", 10), ...many("links", 10)]);
  assert.deepEqual(countByLane(selected), { technical: 4, content: 3, strategy: 2, links: 1 });
  assert.equal(selected.length, 10);
});

test("dentro de un carril entran los de más prioridad", () => {
  const { selected, deferred } = selectByLane(many("technical", 6));
  assert.deepEqual(
    selected.map((c) => c.stableKey),
    ["technical-5", "technical-4", "technical-3", "technical-2"],
  );
  assert.deepEqual(
    deferred.map((c) => c.stableKey),
    ["technical-1", "technical-0"],
  );
});

test("lo urgente entra siempre y no cuenta para el total de 10", () => {
  const { selected } = selectByLane([...many("urgent", 5), ...many("technical", 10), ...many("content", 10), ...many("strategy", 10), ...many("links", 10)]);
  assert.equal(countByLane(selected).urgent, 5);
  assert.equal(selected.length, 15);
});

test("el cupo que no se usa no pasa a otro carril", () => {
  const { selected, deferred } = selectByLane(many("technical", 20, 100));
  assert.equal(selected.length, 4);
  assert.equal(deferred.length, 16);
});

test("respeta las tareas ya creadas hoy y la tanda semanal de enlaces", () => {
  const { selected } = selectByLane([...many("technical", 5), ...many("links", 3), ...many("content", 3)], {
    today: { technical: 3, content: 3 },
    linksThisWeek: 1,
  });
  assert.deepEqual(countByLane(selected), { technical: 1 });
});

test("el total del día nunca pasa de 10 sin contar lo urgente", () => {
  const { selected } = selectByLane([...many("technical", 5), ...many("strategy", 5)], {
    today: { content: 3, links: 1, strategy: 0, technical: 0 },
    linksThisWeek: 1,
  });
  // Quedan 6 huecos: 4 de technical y 2 de strategy.
  assert.deepEqual(countByLane(selected), { technical: 4, strategy: 2 });
  const full = selectByLane(many("technical", 5), { today: { technical: 0, content: 3, strategy: 2, links: 5 }, linksThisWeek: 1 });
  assert.equal(full.selected.length, 0);
});
