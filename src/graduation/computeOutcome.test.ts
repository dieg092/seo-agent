// src/graduation/computeOutcome.test.ts
// Anexo D, prueba 16: positive, negative, inconclusive, pending y not_evaluable
// en el modo de bajo volumen y en el de alto volumen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcome, evaluableFrom, measurementWindows, type OutcomeInput } from "./computeOutcome";

const DAY = 24 * 60 * 60 * 1000;
const deployedAt = new Date("2026-09-01T10:00:00Z");
const later = new Date(deployedAt.getTime() + 60 * DAY);

function input(overrides: Partial<OutcomeInput>): OutcomeInput {
  return {
    deployedAt,
    now: later,
    before: { clicks: 100, impressions: 1000, position: 8 },
    after: { clicks: 100, impressions: 1000, position: 8 },
    metric: "clicks",
    mode: "low",
    ...overrides,
  };
}

const control = { pages: 5, delta: 0, noiseBand: 0.1 };

test("las ventanas empiezan el día siguiente al despliegue más 3 días y duran 28", () => {
  const w = measurementWindows(deployedAt);
  assert.equal(w.before.start.toISOString(), "2026-08-05T00:00:00.000Z");
  assert.equal(w.before.end.toISOString(), "2026-09-02T00:00:00.000Z");
  assert.equal(w.after.start.toISOString(), "2026-09-05T00:00:00.000Z");
  assert.equal(w.after.end.toISOString(), "2026-10-03T00:00:00.000Z");
  assert.equal(evaluableFrom(deployedAt).toISOString(), "2026-10-06T00:00:00.000Z");
});

for (const mode of ["low", "high"] as const) {
  test(`[${mode}] pending hasta que pasan los 28 días y el retraso de GSC`, () => {
    const justBefore = new Date(evaluableFrom(deployedAt).getTime() - 1);
    assert.equal(computeOutcome(input({ mode, control, now: justBefore })).outcome, "pending");
    assert.notEqual(computeOutcome(input({ mode, control, now: evaluableFrom(deployedAt) })).outcome, "pending");
  });

  test(`[${mode}] not_evaluable con un cambio simultáneo en la misma página`, () => {
    const r = computeOutcome(input({ mode, control, simultaneousChange: true, after: { clicks: 300, impressions: 1000 } }));
    assert.equal(r.outcome, "not_evaluable");
  });

  test(`[${mode}] inconclusive con menos de 20 clics de base`, () => {
    assert.equal(computeOutcome(input({ mode, control, before: { clicks: 19, impressions: 1000 }, after: { clicks: 0, impressions: 1000 } })).outcome, "inconclusive");
    assert.equal(computeOutcome(input({ mode, control, before: { clicks: 8, impressions: 1000 }, after: { clicks: 2, impressions: 1000 } })).outcome, "inconclusive");
    assert.equal(computeOutcome(input({ mode, control, before: { clicks: 0, impressions: 1000 }, after: { clicks: 5, impressions: 1000 } })).outcome, "inconclusive");
  });

  test(`[${mode}] nunca positive porque los clics no hayan bajado`, () => {
    assert.equal(computeOutcome(input({ mode, control })).outcome, "inconclusive");
    assert.equal(computeOutcome(input({ mode, control, after: { clicks: 105, impressions: 1000 } })).outcome, "inconclusive");
  });

  test(`[${mode}] inconclusive con menos de 300 impresiones en alguna ventana para el CTR`, () => {
    const r = computeOutcome(
      input({ mode, control, metric: "ctr", before: { clicks: 30, impressions: 299 }, after: { clicks: 290, impressions: 1000 } }),
    );
    assert.equal(r.outcome, "inconclusive");
  });
}

test("[low] positive solo por encima de +50% con al menos 300 impresiones por ventana", () => {
  assert.equal(computeOutcome(input({ after: { clicks: 151, impressions: 1000 } })).outcome, "positive");
  assert.equal(computeOutcome(input({ after: { clicks: 150, impressions: 1000 } })).outcome, "inconclusive");
  assert.equal(computeOutcome(input({ after: { clicks: 140, impressions: 1000 } })).outcome, "inconclusive");
  // Con 299 impresiones no hay veredicto aunque los clics se dupliquen.
  assert.equal(
    computeOutcome(input({ before: { clicks: 30, impressions: 299 }, after: { clicks: 90, impressions: 1000 } })).outcome,
    "inconclusive",
  );
});

test("[low] negative solo por debajo de -50%", () => {
  assert.equal(computeOutcome(input({ after: { clicks: 49, impressions: 1000 } })).outcome, "negative");
  assert.equal(computeOutcome(input({ after: { clicks: 50, impressions: 1000 } })).outcome, "inconclusive");
  // La caída del 15% que antes era «negative» ahora es ruido.
  assert.equal(computeOutcome(input({ after: { clicks: 85, impressions: 1000 } })).outcome, "inconclusive");
});

test("[low] en posición, bajar es mejorar", () => {
  const better = computeOutcome(input({ metric: "position", before: { clicks: 100, impressions: 1000, position: 20 }, after: { clicks: 100, impressions: 1000, position: 9 } }));
  assert.equal(better.outcome, "positive");
  const worse = computeOutcome(input({ metric: "position", before: { clicks: 100, impressions: 1000, position: 8 }, after: { clicks: 100, impressions: 1000, position: 13 } }));
  assert.equal(worse.outcome, "negative");
});

test("[low] no usa el control aunque se pase", () => {
  const r = computeOutcome(input({ control: { pages: 0, delta: 0.9, noiseBand: 0 }, after: { clicks: 160, impressions: 1000 } }));
  assert.equal(r.outcome, "positive");
  assert.equal(r.controlDelta, null);
});

test("[high] not_evaluable sin control o con menos de 3 páginas de control", () => {
  assert.equal(computeOutcome(input({ mode: "high", after: { clicks: 200, impressions: 1000 } })).outcome, "not_evaluable");
  assert.equal(
    computeOutcome(input({ mode: "high", control: { pages: 2, delta: 0, noiseBand: 0.1 }, after: { clicks: 200, impressions: 1000 } })).outcome,
    "not_evaluable",
  );
});

test("[high] positive y negative cuando el efecto supera la banda de ruido", () => {
  const pos = computeOutcome(input({ mode: "high", control, after: { clicks: 120, impressions: 1000 } }));
  assert.equal(pos.outcome, "positive");
  assert.ok(Math.abs((pos.effect ?? 0) - 0.2) < 1e-9);
  const neg = computeOutcome(input({ mode: "high", control, after: { clicks: 85, impressions: 1000 } }));
  assert.equal(neg.outcome, "negative");
});

test("[high] el efecto es la variación de la página menos la del control", () => {
  // La página sube un 20% pero el control sube un 15%: efecto 5%, dentro de la banda.
  const r = computeOutcome(input({ mode: "high", control: { pages: 4, delta: 0.15, noiseBand: 0.1 }, after: { clicks: 120, impressions: 1000 } }));
  assert.equal(r.outcome, "inconclusive");
  assert.ok(Math.abs((r.effect ?? 0) - 0.05) < 1e-9);
  assert.equal(r.controlDelta, 0.15);
  // La página no se mueve pero el control cae un 30%: efecto +30%, positivo.
  const relative = computeOutcome(input({ mode: "high", control: { pages: 4, delta: -0.3, noiseBand: 0.1 } }));
  assert.equal(relative.outcome, "positive");
});

test("[high] inconclusive con menos de 100 impresiones para la posición", () => {
  const r = computeOutcome(
    input({ mode: "high", control, metric: "position", before: { clicks: 30, impressions: 99, position: 20 }, after: { clicks: 30, impressions: 500, position: 5 } }),
  );
  assert.equal(r.outcome, "inconclusive");
  const enough = computeOutcome(
    input({ mode: "high", control, metric: "position", before: { clicks: 30, impressions: 100, position: 20 }, after: { clicks: 30, impressions: 500, position: 5 } }),
  );
  assert.equal(enough.outcome, "positive");
});
