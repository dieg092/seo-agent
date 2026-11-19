// src/editorial/scheduled.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { daysUntil, parsePosts, scheduledFrom } from "./scheduled";
import { prepublishDecision, prepublishStep } from "./prepublish";
import { extractPrepublishFindings, type PrepublishScore } from "./findings";
import { CRITERION_KEYS } from "./rubric";
import { semanticScope } from "../bridge/semanticScope";
import type { Runner } from "./evaluator";

const NOW = new Date("2026-11-19T12:00:00Z");
const POSTS = `import contentA from "./content/organizar-boda/a";
import contentDiseño from "./content/invitaciones/b";
import contentC from "./content/organizar-boda/c";
export const BLOG_POSTS = [
  {
    slug: "a",
    content: contentA,
    categorySlug: "organizar-boda",
    publishedAt: "2026-06-01",
  },
  {
    slug: "b",
    content: contentDiseño,
    categorySlug: "invitaciones",
    publishedAt: "2027-01-10T07:30:00",
  },
  {
    slug: "c",
    content: contentC,
    categorySlug: "organizar-boda",
    publishedAt: "2026-12-01",
  },
];`;
const reply = (score: number, low?: string) => ({ summary: "", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score: k === low ? 3 : score, evidence: ["texto"], note: k === low ? "no dice cuándo enviar" : "" }])) });

beforeEach(async () => {
  await prisma.editorialScore.deleteMany({ where: { kind: "prepublish" } });
});

test("lee posts.ts (también identificadores con ñ) y ordena los programados del más próximo al más lejano", () => {
  assert.equal(parsePosts(POSTS).length, 3);
  const s = scheduledFrom(POSTS, "https://miwebdeboda.com", NOW);
  assert.deepEqual(s.map((a) => a.slug), ["organizar-boda/c", "invitaciones/b"]);
  assert.equal(s[1].contentPath, "src/lib/blog/content/invitaciones/b.ts");
  assert.equal(daysUntil("2026-12-01", NOW), 12);
});

test("decisión previa: nota ≥ 7 y ningún criterio < 4; el motivo dice qué falla", () => {
  const ev = (s: number, low?: string) => ({ score: s, ...reply(s, low) }) as never;
  assert.equal(prepublishDecision({ score: 7.5, evals: [ev(7.5), ev(7.6)] }).approve, true);
  const d = prepublishDecision({ score: 7.5, evals: [ev(7.5, "intencion"), ev(7.6)] });
  assert.equal(d.approve, false);
  assert.match(d.reason, /intencion: no dice cuándo enviar/);
});

test("una evaluación por pasada, el más próximo primero; el mismo texto no se vuelve a evaluar", async () => {
  let calls = 0;
  const r: Runner = async () => {
    calls += 1;
    return reply(6.2, "precision");
  };
  const list = scheduledFrom(POSTS, "https://miwebdeboda.com", NOW).map((a) => ({ ...a, md: `## ${a.slug}\n\nTexto del artículo ${a.slug}.` }));
  const early = new Date("2026-11-01T12:00:00Z");
  assert.match(await prepublishStep(list, r, "https://miwebdeboda.com", early), /organizar-boda\/c \(sale el 2026-12-01, en 30 días\) [\d.]+ a corregir/);
  assert.match(await prepublishStep(list, r, "https://miwebdeboda.com", early), /invitaciones\/b/);
  assert.equal(await prepublishStep(list, r, "https://miwebdeboda.com", early), "");
  assert.equal(calls, 4);
  await prisma.editorialScore.deleteMany({ where: { kind: "prepublish" } });
  assert.match(await prepublishStep(list, r, "https://miwebdeboda.com", NOW), /invitaciones\/b/, "a 12 días ya no se gasta la llamada: pasa al siguiente");
});

test("hallazgo solo con 21 días o más de margen; la corrección previa no puede tocar posts.ts", () => {
  const s = (slug: string, publishedAt: string): PrepublishScore => ({ slug, url: `https://miwebdeboda.com/blog/${slug}`, contentHash: "h".repeat(64), finalScore: 6, decision: "block", reason: "nota 6 < 7", criteria: {}, deterministic: { publishedAt } });
  const f = extractPrepublishFindings([s("x/lejos", "2027-01-10"), s("x/cerca", "2026-12-01")], NOW);
  assert.deepEqual(f.map((x) => x.findingType + ":" + (x.detail as { publishedAt: string }).publishedAt), ["editorial-prepublish:2027-01-10"]);
  const posts = { path: "src/lib/blog/posts.ts", base: "a", head: "b" };
  assert.equal(semanticScope("content-prepublish-fix", [posts], []).ok, false);
});
