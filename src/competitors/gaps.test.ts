// src/competitors/gaps.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_GAP_FINDINGS, extractCompetitorGaps, topicText, type CompetitorTopicPage } from "./gaps";
import { buildContract, validateContract } from "../bridge/contract";

// Vectores unitarios: e(i) es un tema; mezclas cercanas son el mismo tema.
const e = (i: number, n = 8) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
const near = (i: number, j: number, w = 0.2) => e(i).map((x, k) => x + (k === j ? w : 0));
const page = (domain: string, path: string, embedding: number[], h1 = path): CompetitorTopicPage => ({ domain, url: `https://www.${domain}${path}`, path, title: `${h1} | ${domain}`, h1, embedding });

test("hueco: tema de 2 o más competidores que no cubrimos", () => {
  const pages = [
    page("a.com", "/mesas", e(0), "Plano de mesas"),
    page("b.com", "/seating", near(0, 1), "Seating chart"),
    page("a.com", "/solo-a", e(2)),
    page("a.com", "/precios", e(3)),
    page("b.com", "/pricing", near(3, 4)),
  ];
  const ours = [e(3)]; // ya tenemos precios
  const f = extractCompetitorGaps(pages, ours);
  assert.equal(f.length, 1);
  assert.equal(f[0].findingType, "competitor-gap");
  assert.deepEqual((f[0].detail as { domains: string[] }).domains, ["a.com", "b.com"]);
  assert.match(f[0].title, /2 competidores.*Plano de mesas/);
  assert.equal((f[0].detail as { tainted: boolean }).tainted, true);
});

test("estable y con tope; sin embedding no cuenta", () => {
  const pages: CompetitorTopicPage[] = [];
  for (let i = 0; i < 8; i++) pages.push(page("a.com", `/t${i}`, e(i)), page("b.com", `/u${i}`, near(i, (i + 1) % 8, 0.1)));
  pages.push(page("c.com", "/vacio", []));
  const f1 = extractCompetitorGaps(pages, []);
  const f2 = extractCompetitorGaps([...pages].reverse(), []);
  assert.equal(f1.length, MAX_GAP_FINDINGS);
  assert.deepEqual(f1.map((f) => f.stableKeyInput), f2.map((f) => f.stableKeyInput));
  assert.equal(topicText({ title: "T", h1: null }), "T");
});

test("el contrato de un competitor-gap va contaminado y nunca con fusión automática", () => {
  const c = buildContract(
    { id: "o", stableKey: "c".repeat(64), findingType: "competitor-gap", title: "x", detail: {}, page: null, operation: null, autonomy: "A2", lane: "strategy", severity: "low" },
    { now: new Date("2026-11-18T00:00:00Z"), changeId: "c" },
  );
  assert.equal(c.tainted, true);
  assert.ok(validateContract({ ...c, autonomy: "A1", publishPolicy: "auto-merge-if-green" }, { allowAutoMerge: true }).includes("tainted con A1 o fusión automática"));
});
