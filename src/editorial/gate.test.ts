// src/editorial/gate.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { editorialGate, type GateInput } from "./gate";
import { contentFromSource, extractArticleFromMarkdown } from "./article";
import { CRITERION_KEYS, type CriterionKey } from "./rubric";
import type { Runner } from "./evaluator";
import { batteryKey } from "./battery";
import { buildContract, validateContract } from "../bridge/contract";
import { checkScope } from "../bridge/scopeCheck";

const BASE = "https://miwebdeboda.com";
const FILE = "src/lib/blog/content/organizar-boda/after-party.ts";
const URL_ = `${BASE}/blog/organizar-boda/after-party`;
const TASK = "aaaa1111-0000-4000-8000-000000000001";
const src = (body: string) => `const content = \`${body}\`;\n\nexport default content;\n`;
const MAIN = src("## Plazos\\n\\nTexto viejo del artículo sobre la fiesta.");
const HEAD = src("## Plazos\\n\\nTexto nuevo y mejor del artículo sobre la fiesta.");

type Scores = number | Partial<Record<CriterionKey, number>> & { all: number };
const criteria = (s: Scores) => {
  const all = typeof s === "number" ? s : s.all;
  return Object.fromEntries(CRITERION_KEYS.map((k) => [k, { score: typeof s === "number" ? all : (s[k] ?? all), evidence: ["del artículo sobre la fiesta"], note: "" }]));
};

/** Notas por versión (la de main lleva «viejo»); una lista se reparte llamada a llamada. */
function runner(main: Scores | Scores[], head: Scores | Scores[]) {
  let calls = 0;
  const seen = { main: 0, head: 0 };
  const r: Runner = async ({ user }) => {
    calls += 1;
    const side = user.includes("viejo") ? "main" : "head";
    const list = side === "main" ? main : head;
    const s = Array.isArray(list) ? list[seen[side]++ % list.length] : list;
    return { summary: "", criteria: criteria(s) };
  };
  return { r, calls: () => calls };
}

const NOW = new Date("2026-11-18T12:00:00Z");
const input = (over: Partial<GateInput> = {}): GateInput => ({
  files: [FILE, "src/lib/blog/posts.ts"],
  contractUrls: [URL_],
  baseRef: "main",
  headRef: "abc",
  siteBase: BASE,
  readFile: async (_p, ref) => (ref === "main" ? MAIN : HEAD),
  runner: runner(6, 7.6).r,
  now: NOW,
  orbitaTaskId: TASK,
  ...over,
});
const OK_CALIBRATION = () => ({ status: "ok", detail: "", references: [], createdAt: new Date("2026-11-10T00:00:00Z") });
const OK_BATTERY = (over: Record<string, unknown> = {}) => ({ configKey: batteryKey(), passed: true, detected: 20, total: 20, criticalMissed: 0, detail: {}, createdAt: new Date("2026-11-15T00:00:00Z"), ...over });

beforeEach(async () => {
  await prisma.editorialScore.deleteMany({});
  await prisma.editorialCalibration.deleteMany({});
  await prisma.editorialBattery.deleteMany({});
  await prisma.editorialBatteryRun.deleteMany({});
  await prisma.editorialBudget.deleteMany({});
  await prisma.editorialPilot.deleteMany({});
  await prisma.seoChange.deleteMany({});
  await prisma.alert.deleteMany({ where: { type: "editorial-pilot-report" } });
  await prisma.editorialCalibration.create({ data: OK_CALIBRATION() });
  await prisma.editorialBattery.create({ data: OK_BATTERY() });
});

test("aprueba si la rama pasa y mejora a main, reserva plaza en el piloto; la misma versión no se vuelve a evaluar", async () => {
  const run = runner(6, 7.6);
  const d = await editorialGate(input({ runner: run.r }));
  assert.equal(d.code, 0, d.reason);
  assert.match(d.reason, /pasa de 6 a 7.6 \(plaza del piloto reservada\)/);
  assert.equal(run.calls(), 4, "dos evaluaciones de main y dos de la rama");
  assert.equal((await prisma.editorialPilot.findUniqueOrThrow({ where: { orbitaTaskId: TASK } })).state, "reserved");
  const again = await editorialGate(input({ runner: run.r }));
  assert.equal(again.code, 0);
  assert.match(again.reason, /ya reservada/);
  assert.equal(run.calls(), 4, "caché por texto");
});

test("bloquea si no llega a 7 o si casi no mejora", async () => {
  assert.equal((await editorialGate(input({ runner: runner(5, 6.5).r }))).code, 1);
  await prisma.editorialScore.deleteMany({});
  const d = await editorialGate(input({ runner: runner(7.2, 7.4).r }));
  assert.equal(d.code, 1);
  assert.match(d.reason, /solo mejora 0.2/);
});

test("conservadora: main vale la más alta de sus dos notas y la rama la más baja", async () => {
  const d = await editorialGate(input({ runner: runner([6, 6.8], [7.9, 7.2]).r }));
  assert.equal(d.code, 1);
  assert.match(d.reason, /solo mejora 0.4 \(6.8 → 7.2/);
});

test("suelo en todas las evaluaciones de la rama y criterios críticos que no empeoran", async () => {
  const floor = await editorialGate(input({ runner: runner(6, [8, { all: 8, fuentes: 3 }]).r }));
  assert.equal(floor.code, 1);
  assert.match(floor.reason, /por debajo de 4: fuentes/);
  await prisma.editorialScore.deleteMany({});
  const critical = await editorialGate(input({ runner: runner({ all: 6, precision: 9 }, { all: 8, precision: 7 }).r }));
  assert.equal(critical.code, 1);
  assert.match(critical.reason, /empeora criterios críticos: precision/);
});

test("dos evaluaciones que discrepan: desempata una tercera con la mediana", async () => {
  const d = await editorialGate(input({ runner: runner(6, [9.5, 7.2, 8]).r }));
  assert.equal(d.code, 0, d.reason);
  assert.match(d.reason, /pasa de 6 a 8/);
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

test("retiene con la calibración caducada o sin batería de defectos vigente y aprobada", async () => {
  await prisma.editorialCalibration.deleteMany({});
  await prisma.editorialCalibration.create({ data: { ...OK_CALIBRATION(), createdAt: new Date("2026-10-01T00:00:00Z") } });
  assert.match((await editorialGate(input())).reason, /caducado/);
  await prisma.editorialCalibration.deleteMany({});
  await prisma.editorialCalibration.create({ data: OK_CALIBRATION() });
  const cases: [Record<string, unknown> | null, RegExp][] = [
    [null, /falta la batería/],
    [{ passed: false, detected: 15, criticalMissed: 2 }, /no pasa \(15\/20, 2 críticos/],
    [{ createdAt: new Date("2026-10-01T00:00:00Z") }, /ha caducado/],
    [{ configKey: "otra-configuracion" }, /falta la batería/],
  ];
  for (const [over, re] of cases) {
    await prisma.editorialBattery.deleteMany({});
    if (over) await prisma.editorialBattery.create({ data: OK_BATTERY(over) });
    const d = await editorialGate(input());
    assert.equal(d.code, 75);
    assert.match(d.reason, re);
  }
});

test("la correlación nota–GSC ya no retiene: es diagnóstico", async () => {
  await prisma.editorialCalibration.deleteMany({});
  await prisma.editorialCalibration.create({ data: { ...OK_CALIBRATION(), validityN: 13, validityRho: -0.09, validityAt: NOW } });
  assert.equal((await editorialGate(input())).code, 0);
});

test("aprobada pero sin plaza en el piloto: retiene (no bloquea) y dice por qué", async () => {
  assert.match((await editorialGate(input({ orbitaTaskId: undefined }))).reason, /falta la tarea/);
  const at = (d: number) => new Date(NOW.getTime() - d * 86400_000);
  await prisma.editorialPilot.createMany({
    data: [
      { orbitaTaskId: "p1", page: `${BASE}/blog/a/b`, state: "observing", reservedAt: at(40) },
      { orbitaTaskId: "p2", page: `${BASE}/blog/a/c`, state: "observing", reservedAt: at(20) },
    ],
  });
  let d = await editorialGate(input());
  assert.equal(d.code, 75);
  assert.match(d.reason, /piloto lleno \(2 de 2/);
  await prisma.editorialPilot.update({ where: { orbitaTaskId: "p1" }, data: { state: "positive", closedAt: at(1) } });
  d = await editorialGate(input());
  assert.equal(d.code, 0, "20 días desde la última reserva: hay plaza");
  await prisma.editorialPilot.deleteMany({ where: { orbitaTaskId: TASK } });
  await prisma.editorialPilot.update({ where: { orbitaTaskId: "p2" }, data: { reservedAt: at(5) } });
  assert.match((await editorialGate(input())).reason, /siguiente piloto puede salir a partir del 2026-11-27/);
});

test("un negativo de una mejora de artículo pausa el piloto hasta revertir y repetir la batería", async () => {
  const change = { orbitaTaskId: "x", changeId8: "x", stableKey: "k", findingType: "editorial-low-score", operation: "content-improve", page: `${BASE}/blog/a/z` };
  await prisma.seoChange.create({ data: { ...change, status: "revert-open" } });
  assert.match((await editorialGate(input())).reason, /piloto en pausa: el cambio x tiene un negativo sin cerrar/);
  await prisma.seoChange.updateMany({ data: { status: "revert-verified", revertVerifiedAt: new Date("2026-11-16T00:00:00Z") } });
  assert.match((await editorialGate(input())).reason, /falta repetir la batería/);
  await prisma.editorialBattery.create({ data: OK_BATTERY({ createdAt: new Date("2026-11-17T00:00:00Z") }) });
  assert.equal((await editorialGate(input())).code, 0);
});

test("la caché depende de main: si main cambia, se vuelve a evaluar", async () => {
  const run = runner(6, 7.6);
  assert.equal((await editorialGate(input({ runner: run.r }))).code, 0);
  assert.equal(run.calls(), 4);
  const otherMain = src("## Plazos\\n\\nTexto viejo distinto del artículo sobre la fiesta.");
  await editorialGate(input({ runner: run.r, readFile: async (_p, ref) => (ref === "main" ? otherMain : HEAD) }));
  assert.equal(run.calls(), 8, "otra base, otra evaluación");
});

test("cifras nuevas: bloquea sin gastar evaluaciones, lleven o no un enlace al lado", async () => {
  const run = runner(6, 7.6);
  for (const body of ["Texto nuevo: el 73% de las parejas lo hace y cuesta 1.200 €.", "Texto nuevo y mejor: el 73% según [el INE](https://www.ine.es/x)."]) {
    const d = await editorialGate(input({ runner: run.r, readFile: async (_p, ref) => (ref === "main" ? MAIN : src(`## Plazos\\n\\n${body}`)) }));
    assert.equal(d.code, 1);
    assert.match(d.reason, /cifras que no estaban en main ni en los datos admitidos.*\(73%/);
  }
  assert.equal(run.calls(), 0);
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

const POSTS = (date: string) => `import contentAfter from "./content/organizar-boda/after-party";\nexport const BLOG_POSTS = [\n  {\n    slug: "after-party",\n    content: contentAfter,\n    categorySlug: "organizar-boda",\n    publishedAt: "${date}",\n  },\n];\n`;
const prepublishInput = (date: string, over: Partial<GateInput> = {}) =>
  input({ files: [FILE], prepublish: true, readFile: async (p, ref) => (p.endsWith("posts.ts") ? POSTS(date) : ref === "main" ? MAIN : HEAD), ...over });

test("corrección previa: aprobada se fusiona sin plaza del piloto; a menos de 3 días de salir se retiene", async () => {
  const ok = await editorialGate(prepublishInput("2026-12-20", { runner: runner(6, 7.6).r }));
  assert.equal(ok.code, 0, ok.reason);
  assert.match(ok.reason, /corrección previa a la publicación/);
  assert.equal(await prisma.editorialPilot.count(), 0, "no gasta plaza del piloto");
  const late = await editorialGate(prepublishInput("2026-11-20"));
  assert.equal(late.code, 75);
  assert.match(late.reason, /ya no se corrige antes de publicarse/);
  const HEAD2 = src("## Plazos\\n\\nOtro texto nuevo del artículo sobre la fiesta.");
  const blocked = await editorialGate(prepublishInput("2026-12-20", { runner: runner(6, 6.2).r, readFile: async (p, ref) => (p.endsWith("posts.ts") ? POSTS("2026-12-20") : ref === "main" ? MAIN : HEAD2) }));
  assert.equal(blocked.code, 1, "si la rama no aprueba, bloquea como siempre (y se corrige en otra ronda)");
});
