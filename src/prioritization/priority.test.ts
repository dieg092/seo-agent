// src/prioritization/priority.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAging,
  computeLearning,
  computePriority,
  computeValue,
  dismissalValue,
  intentOfPage,
  pageOfFinding,
  type PriorityInput,
} from "./priority";
import { getCatalogEntry, isCritical } from "./catalog";

function base(overrides: Partial<PriorityInput> = {}): PriorityInput {
  return {
    severity: "medium",
    confidence: "observed",
    autonomy: "A1",
    effort: 1,
    intent: "other",
    funnel: null,
    indexationRisk: false,
    learning: null,
    weeksOpen: 0,
    ...overrides,
  };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("sin datos del embudo, value = 1 + intentW (una página nueva nunca vale 0)", () => {
  assert.equal(computeValue("product", null), 2);
  assert.equal(computeValue("professional", null), 1.6);
  assert.equal(computeValue("content", null), 1.2);
  assert.equal(computeValue("other", null), 1);
});

test("value suma ingresos y conversiones con sus topes", () => {
  // revenue 90 € → log10(1 + 9) = 1; 9 pagos → log10(10) = 1.
  close(computeValue("content", { revenueEur90d: 90, payments90d: 9, qualifiedSignups90d: 0 }), 1.2 + 1 + 1);
  // Topes: 2 por ingresos y 1 por conversiones.
  close(computeValue("other", { revenueEur90d: 1_000_000, payments90d: 1000, qualifiedSignups90d: 1000 }), 1 + 2 + 1);
  // Los registros cualificados pesan 0,3.
  close(computeValue("other", { revenueEur90d: 0, payments90d: 0, qualifiedSignups90d: 30 }), 1 + Math.log10(10));
  // Un embudo a cero equivale a no tener datos.
  assert.equal(computeValue("product", { revenueEur90d: 0, payments90d: 0, qualifiedSignups90d: 0 }), 2);
});

test("learning es 1 con menos de 5 mediciones evaluables", () => {
  assert.equal(computeLearning(null), 1);
  assert.equal(computeLearning({ positive: 4, negative: 0 }), 1);
});

test("learning = clamp(0,5, 1,5, 2 × E[Beta(1+pos, 1+neg)])", () => {
  close(computeLearning({ positive: 3, negative: 2 }), 2 * (4 / 7));
  assert.equal(computeLearning({ positive: 50, negative: 0 }), 1.5);
  assert.equal(computeLearning({ positive: 0, negative: 50 }), 0.5);
});

test("aging crece un 5% por semana y se queda en 1,5", () => {
  assert.equal(computeAging(0), 1);
  close(computeAging(4), 1.2);
  assert.equal(computeAging(10), 1.5);
  assert.equal(computeAging(52), 1.5);
});

test("priority aplica la fórmula completa de §12.2 y devuelve todos sus factores", () => {
  const r = computePriority(
    base({
      severity: "high",
      confidence: "derived",
      autonomy: "A2",
      effort: 4,
      intent: "product",
      indexationRisk: true,
      learning: { positive: 3, negative: 2 },
      weeksOpen: 2,
    }),
  );
  assert.deepEqual(Object.keys(r.factors).sort(), ["aging", "confidenceW", "effort", "intentW", "learning", "riskW", "severityW", "urgency", "value"]);
  assert.equal(r.factors.severityW, 5);
  assert.equal(r.factors.value, 2);
  assert.equal(r.factors.confidenceW, 0.8);
  assert.equal(r.factors.urgency, 3);
  assert.equal(r.factors.riskW, 1.3);
  close(r.score, (5 * 2 * 0.8 * 3 * (8 / 7) * 1.1) / (4 * 1.3));
});

test("robots-blocks-all sin página: crítico, urgente y A1", () => {
  const entry = getCatalogEntry("robots-blocks-all");
  const r = computePriority(
    base({ severity: entry.severity, confidence: entry.confidence, autonomy: entry.autonomy, indexationRisk: entry.indexationRisk }),
  );
  assert.equal(r.score, 30);
  assert.equal(isCritical("robots-blocks-all"), true);
  assert.equal(entry.lane, "urgent");
});

test("A2 penaliza un 30% y el esfuerzo se acota entre 1 y 10", () => {
  close(computePriority(base({ autonomy: "A2" })).score, 2.5 / 1.3);
  assert.equal(computePriority(base({ effort: 0 })).factors.effort, 1);
  assert.equal(computePriority(base({ effort: 50 })).factors.effort, 10);
});

test("una página de producto pesa más que una del blog con el mismo hallazgo", () => {
  const product = computePriority(base({ intent: "product" })).score;
  const content = computePriority(base({ intent: "content" })).score;
  assert.ok(product > content);
});

test("dismissalValue = value × severityW", () => {
  const r = computePriority(base({ severity: "high", intent: "product" }));
  assert.equal(dismissalValue(r.factors), 10);
});

test("los hallazgos heurísticos nunca son A1 (Anexo B.1)", () => {
  for (const type of ["internal-link-suggestion", "content-query-gap", "site-architecture-near-duplicate"] as const) {
    const entry = getCatalogEntry(type);
    assert.equal(entry.confidence, "heuristic");
    assert.notEqual(entry.autonomy, "A1");
  }
});

test("intentOfPage clasifica por el primer segmento", () => {
  assert.equal(intentOfPage("https://miwebdeboda.com/"), "product");
  assert.equal(intentOfPage("https://miwebdeboda.com/precios"), "product");
  assert.equal(intentOfPage("/plantillas/olivo"), "product");
  assert.equal(intentOfPage("https://miwebdeboda.com/profesionales/fotografos/madrid"), "professional");
  assert.equal(intentOfPage("/blog/ejemplo-ficticio"), "content");
  assert.equal(intentOfPage("https://miwebdeboda.com/aviso-legal"), "other");
  assert.equal(intentOfPage(null), "other");
  assert.equal(intentOfPage("no es una url"), "other");
});

test("pageOfFinding saca la página del detalle o del stableKeyInput", () => {
  assert.equal(pageOfFinding({ detail: { page: "https://miwebdeboda.com/blog/a" }, stableKeyInput: "x" }), "https://miwebdeboda.com/blog/a");
  assert.equal(pageOfFinding({ detail: { url: "https://miwebdeboda.com/precios" }, stableKeyInput: "x" }), "https://miwebdeboda.com/precios");
  assert.equal(pageOfFinding({ detail: { sourceSlug: "slug-ficticio" }, stableKeyInput: "x" }), "/blog/slug-ficticio");
  assert.equal(
    pageOfFinding({ detail: ["error"], stableKeyInput: "structured-data-missing-field:https://miwebdeboda.com/precios:Product" }),
    "https://miwebdeboda.com/precios",
  );
  assert.equal(pageOfFinding({ detail: "robots.txt bloquea todo", stableKeyInput: "robots-blocks-all" }), null);
});
