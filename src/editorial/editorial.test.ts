// src/editorial/editorial.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CRITERIA, CRITERION_KEYS, NO_EVIDENCE_CAP, applyCaps, combineExcellent, decide, verifyEvidence, weightedScore, type CriteriaScores } from "./rubric";
import { detectHollow } from "./hollow";
import { extractArticle } from "./article";
import { evaluateArticle, evaluationSchema, parseEvaluation, type Runner } from "./evaluator";
import { checkCalibration, computeOutcomes, pickReferences, spearman } from "./calibration";
import { extractEditorialFindings } from "./findings";
import { calibrationDue, isArticleSlug, pickNext } from "./runEditorial";

const all = (score: number, evidence: string[] = []): CriteriaScores =>
  Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score, evidence, note: "" }])) as CriteriaScores;

test("rúbrica: 20 criterios, pesos que suman 100 y media ponderada", () => {
  assert.equal(CRITERIA.length, 20);
  assert.equal(CRITERIA.reduce((s, c) => s + c.weight, 0), 100);
  assert.equal(weightedScore(all(7)), 7);
  const c = all(10);
  c.intencion.score = 0; // peso 8
  assert.equal(weightedScore(c), 9.2);
  assert.deepEqual(Object.keys(evaluationSchema.properties.criteria.properties).sort(), [...CRITERION_KEYS].sort());
});

test("evidencia: solo citas literales o hechos dados; sin ella, tope en 6", () => {
  const text = "Envía la invitación con tres meses de antelación si hay invitados de fuera.";
  assert.deepEqual(verifyEvidence(["«envia la invitacion con tres meses»", "tres meses", "una frase inventada que no está"], text, []), ["«envia la invitacion con tres meses»"]);
  assert.deepEqual(verifyEvidence(["imágenes: 3"], text, ["imágenes: 3"]), ["imágenes: 3"]);
  const capped = applyCaps(all(9, ["inventada por completo aquí"]), text, [], false);
  assert.equal(capped.utilidad.score, NO_EVIDENCE_CAP);
  assert.deepEqual(capped.utilidad.evidence, []);
  const ok = applyCaps(all(9, ["invitados de fuera"]), text, [], true);
  assert.equal(ok.utilidad.score, 9);
  assert.equal(ok.naturalidad.score, 5, "fórmulas vacías topan naturalidad");
  assert.equal(ok.riesgoGenerico.score, 5);
});

test("decisión y confirmación de notas ≥ 9", () => {
  assert.equal(decide(7.5, all(7.5)).decision, "approve");
  assert.equal(decide(6.9, all(6.9)).decision, "block");
  const c = all(8);
  c.precision.score = 3;
  assert.match(decide(7.8, c).reason, /precision/);
  assert.equal(combineExcellent(9.4, 9.2), 9.3);
  assert.equal(combineExcellent(9.4, 8.2), 8.8);
  assert.equal(combineExcellent(9.8, 8.6), 8.9, "sin confirmar no llega a 9");
  assert.equal(combineExcellent(7, null), 7);
});

test("fórmulas vacías: muletillas, conectores, n-gramas y frases iguales", () => {
  assert.equal(detectHollow("Una boda en septiembre cuesta menos en muchas fincas de Madrid.").hollow, false);
  const filler = Array.from({ length: 40 }, () => "Además, en el mundo de las bodas todo lo que necesitas saber es esto.").join(" ");
  const r = detectHollow(filler);
  assert.equal(r.hollow, true);
  const checks = r.signals.map((s) => s.check);
  for (const c of ["muletillas", "conectores", "ngramas-repetidos", "frases-iguales"]) assert.ok(checks.includes(c), c);
});

test("artículo: texto con estructura y hechos citables", () => {
  const html = `<html><body><nav>menú</nav><main><main>
    <h1>Cuándo enviar las invitaciones</h1><p>Con tres meses basta.</p>
    <h2>Plazos</h2><ul><li>Boda de destino: seis meses</li></ul>
    <table><tr><th>Tipo</th><th>Plazo</th></tr><tr><td>Local</td><td>3 meses</td></tr></table>
    <img src="a.jpg" alt="Invitación"><img src="b.jpg">
    <a href="/blog/rsvp">rsvp</a><a href="https://miwebdeboda.com/precios">precios</a><a href="https://boe.es/x">BOE</a>
    <script>no</script></main></main><footer>pie</footer></body></html>`;
  const d = extractArticle(html, "https://miwebdeboda.com");
  assert.ok(d.text.startsWith("# Cuándo enviar las invitaciones"));
  assert.ok(d.text.includes("\n## Plazos"));
  assert.ok(d.text.includes("- Boda de destino: seis meses"));
  assert.ok(d.text.includes("| Local | 3 meses |"));
  assert.ok(!d.text.includes("menú") && !d.text.includes("pie") && !d.text.includes("no\n"));
  for (const f of ["imágenes: 2", "imágenes sin alt: 1", "tablas: 1", "enlaces internos: 2", "enlaces externos: 1", "enlace interno: /blog/rsvp"]) assert.ok(d.facts.includes(f), f);
});

test("evaluador: valida la respuesta y aplica los topes", async () => {
  assert.throws(() => parseEvaluation({ criteria: {} }), /sin nota/);
  const doc = { text: "Con tres meses de antelación basta para una boda local.", facts: ["tablas: 0"], words: 10 };
  const runner: Runner = async ({ user, schema }) => {
    assert.ok(user.includes("ARTÍCULO:") && user.includes("tablas: 0"));
    assert.equal((schema as { type: string }).type, "object");
    return { summary: "ok", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score: 8, evidence: k === "utilidad" ? ["tres meses de antelación basta"] : ["no está en el texto en absoluto"], note: "n" }])) };
  };
  const e = await evaluateArticle({ url: "u", doc, hollow: { signals: [], hollow: false, words: 10 }, similar: [] }, runner);
  assert.equal(e.criteria.utilidad.score, 8);
  assert.equal(e.criteria.precision.score, 6);
  assert.ok(e.score > 6 && e.score < 6.3);
});

test("calibración con GSC: resultados, referencias y comprobaciones", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ slug: `a${i}`, impressions: 1000, clicks: 2 ** (8 - i), position: 5 + i }));
  rows.push({ slug: "pocas", impressions: 50, clicks: 40, position: 1 });
  const out = computeOutcomes(rows);
  assert.equal(out.length, 8, "sin las de menos de 100 impresiones");
  assert.equal(out.find((o) => o.slug === "a0")!.outcome, 10);
  assert.equal(out.find((o) => o.slug === "a7")!.outcome, 0);
  const refs = pickReferences(out);
  assert.deepEqual(refs.map((r) => [r.slug, r.tier]), [["a0", "good"], ["a1", "good"], ["a3", "mid"], ["a4", "mid"], ["a6", "bad"], ["a7", "bad"]]);
  assert.deepEqual(pickReferences(out.slice(0, 5)), []);

  const anchored = refs.map((r, i) => ({ ...r, anchor: 8 - i * 0.5 }));
  const s = (v: number[]) => new Map(refs.map((r, i) => [r.slug, v[i]]));
  const agree = Array.from({ length: 12 }, (_, i) => [i, i] as [number, number]);
  const against = agree.map(([a]) => [a, 11 - a] as [number, number]);
  assert.equal(checkCalibration(anchored, s([8, 7.5, 7, 6.5, 6, 5.5]), agree).status, "ok");
  assert.equal(checkCalibration(anchored, s([8, 7.5, 7, 6.5, 6, 7]), agree).status, "drift");
  assert.equal(checkCalibration(anchored, s([8, 7.5, 7, 6.5, 6, 5.5]), against).status, "inverted");
  assert.match(checkCalibration(anchored, s([8, 7.5, 7, 6.5, 6, 5.5]), against.slice(0, 11)).detail, /pendiente \(11\/12/, "con pocos artículos no se juzga la validez");
  assert.equal(spearman(agree), 1);
  assert.equal(spearman(against), -1);
});

test("cuándo calibrar y qué artículo toca", () => {
  const now = new Date("2026-11-18T10:00:00Z");
  const d = (days: number) => new Date(now.getTime() - days * 86400_000);
  assert.equal(calibrationDue(null, now), true);
  assert.equal(calibrationDue({ status: "ok", createdAt: d(10) }, now), false);
  assert.equal(calibrationDue({ status: "ok", createdAt: d(31) }, now), true);
  assert.equal(calibrationDue({ status: "drift", createdAt: d(1.1) }, now), true);
  assert.equal(calibrationDue({ status: "inverted", createdAt: d(3) }, now), false);

  const arts = ["a", "b", "c", "d"].map((slug) => ({ slug }));
  const latest = new Map([["a", { createdAt: d(5) }], ["b", { createdAt: d(100) }], ["c", { createdAt: d(10) }], ["d", { createdAt: d(1) }]]);
  assert.equal(pickNext(arts, latest, new Map(), now)?.slug, "b", "la nota más antigua de 90 días");
  assert.equal(pickNext(arts, latest, new Map([["c", d(2)]]), now)?.slug, "c", "cambiado desde su nota va antes");
  assert.equal(pickNext([...arts, { slug: "nuevo" }], latest, new Map(), now)?.slug, "nuevo");
  assert.equal(pickNext([{ slug: "d" }], latest, new Map(), now), null);
});

test("hallazgos: los bloqueados, peores primero, con sus criterios flojos", () => {
  const crit = Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score: k === "fuentes" ? 2 : 7, note: k }]));
  const f = extractEditorialFindings([
    { slug: "bien", url: "u1", contentHash: "h".repeat(64), finalScore: 8, decision: "approve", reason: "", criteria: crit },
    { slug: "mal", url: "u2", contentHash: "a".repeat(64), finalScore: 5.2, decision: "block", reason: "nota 5.2 < 7", criteria: crit },
  ]);
  assert.equal(f.length, 1);
  assert.equal(f[0].findingType, "editorial-low-score");
  assert.match(f[0].title, /mal.*5\.2/);
  assert.equal((f[0].detail as { weakest: { criterion: string }[] }).weakest[0].criterion, "fuentes");
});

test("solo artículos, no categorías", () => {
  assert.equal(isArticleSlug("organizar-boda/cuanto-se-tarda"), true);
  assert.equal(isArticleSlug("organizar-boda"), false);
  assert.equal(isArticleSlug("organizar-boda/x?utm=1"), false);
  assert.equal(isArticleSlug("a/b/c"), false);
});
