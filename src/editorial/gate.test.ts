// src/editorial/gate.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { editorialGate, type GateInput } from "./gate";
import { contentFromSource, extractArticleFromMarkdown } from "./article";
import { CRITERION_KEYS } from "./rubric";
import type { Runner } from "./evaluator";
import { buildContract, validateContract } from "../bridge/contract";
import { checkScope } from "../bridge/scopeCheck";

const BASE = "https://miwebdeboda.com";
const FILE = "src/lib/blog/content/organizar-boda/after-party.ts";
const URL_ = `${BASE}/blog/organizar-boda/after-party`;
const src = (body: string) => `const content = \`${body}\`;\n\nexport default content;\n`;
const MAIN = src("## Plazos\\n\\nTexto viejo del artículo sobre la fiesta.");
const HEAD = src("## Plazos\\n\\nTexto nuevo y mejor del artículo sobre la fiesta.");

/** Nota según la versión que se evalúa: la de main lleva «viejo». */
function runner(main: number, head: number) {
  let calls = 0;
  const r: Runner = async ({ user }) => {
    calls += 1;
    const score = user.includes("viejo") ? main : head;
    return { summary: "", criteria: Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score, evidence: ["del artículo sobre la fiesta"], note: "" }])) };
  };
  return { r, calls: () => calls };
}

const input = (over: Partial<GateInput> = {}): GateInput => ({
  files: [FILE, "src/lib/blog/posts.ts"],
  contractUrls: [URL_],
  baseRef: "main",
  headRef: "abc",
  siteBase: BASE,
  readFile: async (_p, ref) => (ref === "main" ? MAIN : HEAD),
  runner: runner(6, 7.6).r,
  now: new Date("2026-11-18T12:00:00Z"),
  ...over,
});

beforeEach(async () => {
  await prisma.editorialScore.deleteMany({});
  await prisma.editorialCalibration.deleteMany({});
  await prisma.editorialCalibration.create({ data: OK_CALIBRATION() });
});

const NOW = new Date("2026-11-18T12:00:00Z");
const OK_CALIBRATION = () => ({ status: "ok", detail: "", references: [], createdAt: new Date("2026-11-10T00:00:00Z"), validityN: 14, validityRho: 0.35, validityAt: new Date("2026-11-18T11:00:00Z") });

test("aprueba si la rama pasa y mejora a main; la misma versión no se vuelve a evaluar", async () => {
  const run = runner(6, 7.6);
  const d = await editorialGate(input({ runner: run.r }));
  assert.equal(d.code, 0, d.reason);
  assert.match(d.reason, /pasa de 6 a 7.6/);
  assert.equal(run.calls(), 2);
  const again = await editorialGate(input({ runner: run.r }));
  assert.equal(again.code, 0);
  assert.equal(run.calls(), 2, "caché por texto");
});

test("bloquea si no llega a 7 o si casi no mejora", async () => {
  assert.equal((await editorialGate(input({ runner: runner(5, 6.5).r }))).code, 1);
  await prisma.editorialScore.deleteMany({});
  const d = await editorialGate(input({ runner: runner(7.2, 7.4).r }));
  assert.equal(d.code, 1);
  assert.match(d.reason, /solo mejora 0.2/);
});

test("retiene sin calibración en verde; bloquea si el artículo no es el del contrato o hay dos", async () => {
  await prisma.editorialCalibration.create({ data: { status: "drift", detail: "", references: [], createdAt: new Date("2026-11-11T00:00:00Z") } });
  assert.equal((await editorialGate(input())).code, 75);
  await prisma.editorialCalibration.deleteMany({});
  await prisma.editorialCalibration.create({ data: OK_CALIBRATION() });
  assert.match((await editorialGate(input({ contractUrls: [`${BASE}/blog/organizar-boda/otro`] }))).reason, /no es el del contrato/);
  assert.match((await editorialGate(input({ files: [FILE, "src/lib/blog/content/organizar-boda/otro.ts"] }))).reason, /un solo artículo \(cambia 2\)/);
  assert.equal((await editorialGate(input({ readFile: async () => null }))).code, 1);
});

test("retiene con la calibración caducada, sin validez reciente, pendiente o en contra de GSC", async () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ createdAt: new Date("2026-10-01T00:00:00Z") }, /caducado/],
    [{ validityAt: new Date("2026-11-15T00:00:00Z") }, /sin validez reciente/],
    [{ validityN: 10 }, /validez pendiente \(10 de 12/],
    [{ validityRho: -0.1 }, /no acompaña/],
  ];
  for (const [over, re] of cases) {
    await prisma.editorialCalibration.deleteMany({});
    await prisma.editorialCalibration.create({ data: { ...OK_CALIBRATION(), ...over } as never });
    const d = await editorialGate(input());
    assert.equal(d.code, 75);
    assert.match(d.reason, re);
  }
});

test("la caché depende de main: si main cambia, se vuelve a evaluar", async () => {
  const run = runner(6, 7.6);
  assert.equal((await editorialGate(input({ runner: run.r }))).code, 0);
  assert.equal(run.calls(), 2);
  const otherMain = src("## Plazos\\n\\nTexto viejo distinto del artículo sobre la fiesta.");
  await editorialGate(input({ runner: run.r, readFile: async (_p, ref) => (ref === "main" ? otherMain : HEAD) }));
  assert.equal(run.calls(), 4, "otra base, otra evaluación");
});

test("markdown del repositorio: texto y hechos", () => {
  assert.equal(contentFromSource(src("a \\`b\\` c")), "a `b` c");
  const md = `Intro con [enlace](/blog/x) y **negrita**.\n\n<img src="/a.webp" alt="Una mesa" className="w-full" />\n![](/b.webp)\n\n## Precios\n\n| Tipo | Precio |\n|---|---|\n| Local | 300 € |\n\n- uno\n- dos\n\nVer <a href="https://boe.es/x">el BOE</a>.`;
  const d = extractArticleFromMarkdown(md, BASE, "Título");
  assert.ok(d.text.startsWith("# Título\nIntro con enlace y negrita."));
  assert.ok(d.text.includes("\n## Precios") && d.text.includes("| Local | 300 € |") && d.text.includes("- dos") && d.text.includes("Ver el BOE."));
  for (const f of ["imágenes: 2", "imágenes sin alt: 1", "tablas: 1", "listas: 1", "enlaces internos: 1", "enlaces externos: 1", "encabezados h2: 1"]) assert.ok(d.facts.includes(f), f);
});

test("content-improve: contrato A1 válido con fusión automática y alcance de un artículo", () => {
  const c = buildContract(
    { id: "o", stableKey: "e".repeat(64), findingType: "editorial-low-score", title: "Mejorar", detail: { page: URL_ }, page: URL_, operation: "content-improve", autonomy: "A1", lane: "content", severity: "medium" },
    { now: new Date(), changeId: "x" },
  );
  assert.deepEqual(c.urls, [URL_]);
  assert.ok(c.tests.includes("pnpm blog:lint"));
  assert.deepEqual(validateContract({ ...c, publishPolicy: "auto-merge-if-green" }, { allowAutoMerge: true }), []);
  assert.equal(checkScope("content-improve", [{ path: FILE, added: 120, deleted: 80 }, { path: "src/lib/blog/posts.ts", added: 1, deleted: 1 }]).ok, true);
  assert.equal(checkScope("content-improve", [{ path: "src/components/x.tsx", added: 1, deleted: 0 }]).ok, false);
});
