import { test } from "node:test";
import assert from "node:assert/strict";
import { buildKeywordRows, classifyIntent, clusterQueries, demandOf, extractStrategyFindings, summarizeClusters } from "./keywords";

const SITE = "https://miwebdeboda.com";

test("intención por modificadores en castellano", () => {
  assert.equal(classifyIntent("web de boda gratis"), "transactional");
  assert.equal(classifyIntent("cuánto cuesta una invitación digital"), "transactional");
  assert.equal(classifyIntent("mejores webs de boda"), "commercial");
  assert.equal(classifyIntent("zola vs bodas.net"), "comparison");
  assert.equal(classifyIntent("fotos de mesas de boda"), "image");
  assert.equal(classifyIntent("cuándo enviar las invitaciones de boda"), "informational");
  assert.equal(classifyIntent("web de bodas"), "commercial");
  assert.equal(classifyIntent("invitación digital boda"), "commercial");
});

test("demanda cualitativa por impresiones", () => {
  assert.equal(demandOf(10), "low");
  assert.equal(demandOf(80), "medium");
  assert.equal(demandOf(400), "high");
});

test("buildKeywordRows agrega por consulta y elige la mejor página por posición", () => {
  const rows = buildKeywordRows([
    { query: "q", page: `${SITE}/a`, impressions: 10, clicks: 1, position: 8 },
    { query: "q", page: `${SITE}/b`, impressions: 30, clicks: 0, position: 3 },
    { query: "q", page: `${SITE}/a`, impressions: 10, clicks: 0, position: 12 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].impressions90d, 50);
  assert.equal(rows[0].bestPage, `${SITE}/b`);
  assert.equal(rows[0].avgPosition, (8 * 10 + 3 * 30 + 12 * 10) / 50);
});

test("clusterQueries agrupa por similitud ≥ 0,8 alrededor de la consulta con más impresiones", () => {
  const a = clusterQueries([
    { query: "web boda", impressions: 100, embedding: [1, 0] },
    { query: "pagina web boda", impressions: 50, embedding: [0.95, 0.1] },
    { query: "vestido novia", impressions: 80, embedding: [0, 1] },
    { query: "sin vector", impressions: 5, embedding: [] },
  ]);
  assert.equal(a.get("pagina web boda"), "web boda");
  assert.equal(a.get("vestido novia"), "vestido novia");
  assert.equal(a.has("sin vector"), false);
});

test("hallazgos de estrategia: falta página comercial y hueco de tema", () => {
  const keywords = buildKeywordRows([
    { query: "web boda gratis", page: `${SITE}/blog/x/y`, impressions: 150, clicks: 1, position: 9 },
    { query: "ideas boda otoño", page: `${SITE}/blog/x/z`, impressions: 120, clicks: 0, position: 35 },
    { query: "precio web boda", page: `${SITE}/precios`, impressions: 200, clicks: 5, position: 4 },
  ]);
  const assignment = new Map(keywords.map((k) => [k.query, k.query]));
  const clusters = summarizeClusters(keywords, assignment).map((c, i) => ({ ...c, id: `c${i}` }));
  const out = extractStrategyFindings(clusters).map((f) => f.stableKeyInput).sort();
  assert.deepEqual(out, ["commercial-page-missing:web boda gratis", "topic-cluster-gap:ideas boda otoño"]);
});
