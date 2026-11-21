// src/repair/web/web.test.ts — autorreparación de la web: clasificación, privacidad, guarda y
// máquina de estados con dobles de GitHub, git y modelo (sin red; BD de pruebas).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../../db";
import type { DiffFile } from "../guard";
import { classifyWebFailure, WEB_SOURCES, webSignature, type WebSource } from "./classify";
import { errorLines, sanitizeLine } from "./privacy";
import { guardWebDiff, protectedMatcher } from "./guard";
import { webRepairPrompt } from "./contract";
import type { PrState, Run } from "./github";
import { advanceWebPrs, observeWeb, repairWeb, verifyWeb, type WebDeps } from "./supervisor";

const H = 3_600_000;
const NOW = new Date("2026-11-21T12:00:00Z");

// ---------- clasificación ----------

const fail = (component: string, failedSteps: string[], lines: string[], conclusion = "failure") => classifyWebFailure({ component, conclusion, failedSteps, lines });

test("web: clasifica sin modelo por fuente", () => {
  assert.equal(fail("web-ci", ["Typecheck · Test · Build :: Typecheck"], ["src/app/x.tsx(3,1): error TS2322: Type 'string' is not assignable"]).kind, "code");
  assert.equal(fail("web-ci", ["checks :: Install"], ["ERR_PNPM_META_FETCH_FAIL GET <url>: ECONNRESET"]).kind, "transient");
  assert.equal(fail("web-ci", [], [], "cancelled").kind, "transient");
  const canary = fail("web-health", ["Canario de email + latido de crons :: Send canary email and verify delivery"], ["Intento 60/60: last_event=delivery_delayed", "El email canario (id=<id>) no alcanzó un estado de entrega tras 60 intentos."]);
  assert.equal(canary.kind, "external");
  assert.match(canary.founderStep!, /buzón/);
  const gate = fail("web-deploy", ["Verificar :: Verificar que el commit es desplegable"], ["::error::la huella de los ficheros protegidos no está aprobada: bash scripts/aprobar.sh huella <sha>"]);
  assert.equal(gate.kind, "founder");
  assert.match(gate.founderStep!, /aprobar\.sh huella/);
  assert.equal(fail("web-deploy", ["Verificar :: Verificar"], ["::error::esta ejecución usa la versión abc y main está en def: lanza el despliegue de nuevo (no lo relances)"]).kind, "transient");
  assert.equal(fail("web-monitor", ["monitor :: Run"], ["HttpError: Bad credentials"]).kind, "founder");
  assert.equal(fail("web-ci", ["build :: E2E"], ["✘ e2e/blog.spec.ts:12 › muestra el índice", "Error: expect(locator).toBeVisible() failed"]).kind, "code");
});

test("web: la firma no depende de ids, números ni shas", () => {
  const a = webSignature({ component: "web-ci", failedSteps: ["build :: E2E"], lines: ["✘ e2e/a.spec.ts:12 › x (3.2s)", "Error: timeout 5000ms exceeded abcdef1234"] });
  const b = webSignature({ component: "web-ci", failedSteps: ["build :: E2E"], lines: ["✘ e2e/a.spec.ts:14 › x (9.1s)", "Error: timeout 7000ms exceeded 9876fedcba"] });
  assert.equal(a, b);
});

// ---------- privacidad ----------

test("web: las líneas de error salen sin URLs, rutas web, correos ni secretos", () => {
  const log = [
    "build\tE2E\t2026-11-21T09:00:00.000Z Error: page /maria-y-juan devolvió 500",
    "build\tE2E\t2026-11-21T09:00:00.000Z     at https://miwebdeboda.com/boda/ana-luis?x=1",
    "checks\tRun\t2026-11-21T09:00:00.000Z Error: usuario pareja@example.com token=abcdefabcdef1234567890",
    "checks\tRun\t2026-11-21T09:00:00.000Z Error: postgresql://u:p@host/db re_123456789abcdefgh",
    "checks\tRun\t2026-11-21T09:00:00.000Z src/app/page.tsx(3,1): error TS2322",
  ].join("\n");
  const out = errorLines(log).join("\n");
  assert.doesNotMatch(out, /maria-y-juan|ana-luis|miwebdeboda\.com|pareja@|abcdefabcdef|postgresql:|re_1234/);
  assert.match(out, /src\/app\/page\.tsx\(3,1\): error TS2322/);
  assert.doesNotMatch(sanitizeLine("fallo en /ana-y-luis"), /ana-y-luis/);
});

// ---------- guarda ----------

const PROTECTED = existsSync(join(homedir(), "Projects/infra/miwebdeboda-deploy/protegido.txt"))
  ? readFileSync(join(homedir(), "Projects/infra/miwebdeboda-deploy/protegido.txt"), "utf8")
  : ".github/**\npackage.json\ne2e/**\n!e2e/**/*.spec.ts\nnext.config.*\nprisma/migrations/**\n";
const isProtected = protectedMatcher(PROTECTED);
const file = (path: string, over: Partial<DiffFile> = {}): DiffFile => ({ path, status: "M", added: 3, deleted: 1, addedLines: ["const x = 1;"], ...over });

test("web guarda: acepta un arreglo en src con un spec nuevo", () => {
  assert.deepEqual(guardWebDiff([file("src/app/blog/page.tsx"), file("e2e/blog.spec.ts", { deleted: 0, addedLines: ["  await expect(x).toBeVisible();"] })], isProtected), { ok: true });
});

test("web guarda: lo protegido se marca como tal y lo demás se rechaza", () => {
  const prot = guardWebDiff([file(".github/workflows/ci.yml")], isProtected);
  assert.equal(prot.ok, false);
  assert.equal(prot.ok === false && prot.protectedHit, true);
  for (const f of [
    file("package.json"),
    file("next.config.ts"),
    file("e2e/helpers/setup.ts"),
    file("prisma/schema.prisma"),
    file(".env.local"),
    file("src/lib/seo/seo-guard.test.ts", { deleted: 0 }),
    file("src/x.test.ts", { deleted: 2 }),
    file("src/x.test.ts", { deleted: 0, addedLines: ["test.skip('x', () => {})"] }),
    file("e2e/a.spec.ts", { deleted: 0, addedLines: ["test.fixme('x')"] }),
    file("src/a.tsx", { addedLines: ["color: '#ff00aa'"] }),
    file("src/a.ts", { addedLines: ["const apiKey = 'sk_live_abcdefghijklmnop'"] }),
    file("src/a.ts", { status: "D" }),
    file("public/logo.png"),
  ]) {
    assert.equal(guardWebDiff([f], isProtected).ok, false, `${f.path} ${f.addedLines[0]}`);
  }
});

test("web: el prompt lleva las reglas y no la evidencia sin marcar", () => {
  const p = webRepairPrompt({ incidentId: "abcd1234", source: "ci.yml", component: "web-ci", baseSha: "f".repeat(40), signature: "web-ci | x", evidence: "Error: x" });
  assert.match(p, /<datos>\nError: x\n<\/datos>/);
  assert.match(p, /No cambies \.github/);
  assert.match(p, /"veredicto": "reparado\|sin_cambio\|necesita_fundador"/);
});

// ---------- máquina de estados ----------

let clock = NOW;
let runs: Record<string, Run[]> = {};
let failures: Record<number, { failedSteps: string[]; lines: string[] }> = {};
let retried: number[] = [];
let notes: { type: string; subject: string; body: string }[] = [];
let agentText = "";
let agentDiff: DiffFile[] = [];
let gateResults: boolean[] = [];
let pr: PrState = { state: "OPEN", head: "h1", branch: "ia/reparacion-x-1", behind: 0, mergeSha: null };
let branchRun: Run | null = null;
let merged = 0;
let closed = 0;
let dispatched = 0;
let agentCalls = 0;

const run = (id: number, conclusion: string, createdAt: string, over: Partial<Run> = {}): Run => ({ id, attempt: 1, status: "completed", conclusion, createdAt, headSha: `sha${id}`, event: "push", url: `run/${id}`, ...over });
const report = (veredicto: string) => JSON.stringify({ veredicto, diagnostico: "faltaba un caso", cambios: [], tests: [], paso_fundador: null, commit: "corrige el indice del blog" });

const deps = (): WebDeps => ({
  now: () => clock,
  notify: async (a) => void notes.push(a),
  reserve: async () => {},
  runs: (s: WebSource) => runs[s.component] ?? [],
  failure: (_s, r) => failures[r.id] ?? { failedSteps: ["checks :: Typecheck"], lines: ["src/a.ts(1,1): error TS2322: x"] },
  retry: (_s, r) => (retried.push(r.id), true),
  createWorkspace: () => ({ dir: "/tmp/no-existe", baseSha: "base", dispose: () => {} }),
  runAgent: async () => (agentCalls++, { ok: true, text: agentText, denials: [] }),
  diff: () => agentDiff,
  gate: () => ({ ok: gateResults.shift() ?? true, detail: "ok" }),
  isProtected,
  pushPr: () => ({ number: 7, url: "pr/7", head: "h1" }),
  pr: () => pr,
  updateBranch: () => {},
  dispatchCi: () => void dispatched++,
  branchCi: () => branchRun,
  merge: () => (merged++, "m".repeat(40)),
  close: () => void closed++,
  revertInto: () => {},
});

beforeEach(async () => {
  clock = NOW;
  runs = {};
  failures = {};
  retried = [];
  notes = [];
  agentText = report("reparado");
  agentDiff = [file("src/app/blog/page.tsx")];
  gateResults = [];
  pr = { state: "OPEN", head: "h1", branch: "ia/reparacion-x-1", behind: 0, mergeSha: null };
  branchRun = null;
  merged = closed = dispatched = agentCalls = 0;
  await prisma.repairIncident.deleteMany({});
});

after(async () => {
  await prisma.repairIncident.deleteMany({});
  await prisma.$disconnect();
});

test("web: un fallo se relanza una vez; si pasa al relanzarlo es intermitente y no se repara", async () => {
  runs["web-ci"] = [run(10, "failure", "2026-11-21T10:00:00Z")];
  let c = (await observeWeb({}, deps())).cursor;
  assert.deepEqual(retried, [10]);
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).status, "waiting");
  // el rerun es el intento 2 de la misma ejecución
  runs["web-ci"] = [run(10, "success", "2026-11-21T10:00:00Z", { attempt: 2 })];
  c = (await observeWeb(c, deps())).cursor;
  const i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "resolved");
  assert.equal((i.result as { flaky: string[] }).flaky.length, 1);
  assert.equal(c["web-ci"], "10:2");
});

test("web: si falla también al relanzarlo es de código y se repara; nada se repite ni se duplica", async () => {
  runs["web-ci"] = [run(10, "failure", "2026-11-21T10:00:00Z")];
  let c = (await observeWeb({}, deps())).cursor;
  runs["web-ci"] = [run(10, "failure", "2026-11-21T10:00:00Z", { attempt: 2 })];
  c = (await observeWeb(c, deps())).cursor;
  // la misma ejecución vista otra vez no cuenta
  await observeWeb(c, deps());
  const rows = await prisma.repairIncident.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "open");
  assert.equal(rows[0].occurrences, 2);
  assert.equal(retried.length, 1);
});

test("web: lo externo se relanza y, si sigue, se avisa al fundador una sola vez con el paso", async () => {
  failures[20] = failures[21] = { failedSteps: ["check :: Send canary email"], lines: ["Intento 60/60: last_event=delivery_delayed"] };
  runs["web-health"] = [run(20, "failure", "2026-11-21T09:00:00Z")];
  let c = (await observeWeb({}, deps())).cursor;
  assert.deepEqual(retried, [20]);
  runs["web-health"] = [run(20, "failure", "2026-11-21T09:00:00Z", { attempt: 2 })];
  c = (await observeWeb(c, deps())).cursor;
  runs["web-health"] = [run(21, "failure", "2026-11-22T09:00:00Z"), run(20, "failure", "2026-11-21T09:00:00Z", { attempt: 2 })];
  await observeWeb(c, deps());
  assert.equal(notes.filter((n) => n.type === "seo-repair-founder").length, 1);
  assert.match(notes[0].body, /buzón/);
  // vuelve a verde: se cierra solo
  runs["web-health"] = [run(22, "success", "2026-11-23T09:00:00Z")];
  await observeWeb({ "web-health": "21:1" }, deps());
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).status, "resolved");
});

async function openCodeIncident() {
  runs["web-ci"] = [run(10, "failure", "2026-11-21T10:00:00Z")];
  const c = (await observeWeb({}, deps())).cursor;
  runs["web-ci"] = [run(10, "failure", "2026-11-21T10:00:00Z", { attempt: 2 })];
  await observeWeb(c, deps());
}

test("web: reparar → PR + CI completa → squash solo con la CI del commit exacto en verde", async () => {
  await openCodeIncident();
  const line = await repairWeb(deps());
  assert.match(line, /PR pr\/7/);
  assert.equal(dispatched, 1);
  let i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "pr-open");
  // sin CI todavía: espera
  await advanceWebPrs(deps());
  assert.equal(merged, 0);
  // CI de otro commit: no vale
  branchRun = null;
  // rama atrasada respecto a main: se pone al día y se relanza la CI
  pr = { ...pr, behind: 2 };
  await advanceWebPrs(deps());
  assert.equal(dispatched, 2);
  pr = { ...pr, behind: 0 };
  branchRun = run(99, "success", "2026-11-21T12:30:00Z", { headSha: "h1", event: "workflow_dispatch" });
  await advanceWebPrs(deps());
  assert.equal(merged, 1);
  i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "verifying");
  assert.equal(i.mergedSha, "m".repeat(40));
  // otra reparación no empieza mientras tanto
  assert.match(await repairWeb(deps()), /nada pendiente|otra en curso/);
});

test("web: CI de la rama roja → PR cerrado y se reintenta más tarde; al 2.º fallo se avisa", async () => {
  await openCodeIncident();
  await repairWeb(deps());
  branchRun = run(99, "failure", "2026-11-21T12:30:00Z", { headSha: "h1", event: "workflow_dispatch" });
  await advanceWebPrs(deps());
  assert.equal(closed, 1);
  let i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "open");
  assert.ok(i.nextAttemptAt! > clock);
  clock = new Date(NOW.getTime() + 7 * H);
  await repairWeb(deps());
  await advanceWebPrs(deps());
  i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "escalated");
  assert.equal(notes.filter((n) => n.type === "seo-repair-escalated").length, 1);
});

test("web: guarda y puerta local mandan; lo protegido va al fundador sin publicar", async () => {
  await openCodeIncident();
  agentDiff = [file(".github/workflows/ci.yml")];
  assert.match(await repairWeb(deps()), /protegidos/);
  assert.equal(dispatched, 0);
  assert.equal(notes.filter((n) => n.type === "seo-repair-founder").length, 1);
  await prisma.repairIncident.deleteMany({});
  notes = [];
  await openCodeIncident();
  agentDiff = [file("src/app/blog/page.tsx")];
  gateResults = [false, false]; // antes (reproduce) y después (sigue fallando)
  assert.match(await repairWeb(deps()), /puerta-local/);
  assert.equal(dispatched, 0);
});

test("web: verificación — CI de main + despliegue + fuente sana → resuelta; CI del commit roja → reversión", async () => {
  await openCodeIncident();
  await repairWeb(deps());
  branchRun = run(99, "success", "2026-11-21T12:30:00Z", { headSha: "h1", event: "workflow_dispatch" });
  clock = new Date("2026-11-21T13:00:00Z");
  await advanceWebPrs(deps());
  // CI de main del commit fusionado en verde, desplegado y la CI sana
  runs["web-ci"] = [run(30, "success", "2026-11-21T13:05:00Z", { headSha: "m".repeat(40) })];
  runs["web-deploy"] = [run(31, "success", "2026-11-21T13:20:00Z")];
  await verifyWeb(deps());
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).status, "resolved");
  assert.equal(notes.filter((n) => n.type === "seo-repair-fixed").length, 1);

  // otra vez, pero la CI de main del commit fusionado falla → PR de reversión
  await prisma.repairIncident.deleteMany({});
  runs = {};
  merged = 0;
  clock = NOW;
  await openCodeIncident();
  await repairWeb(deps());
  clock = new Date("2026-11-21T13:00:00Z");
  await advanceWebPrs(deps());
  runs["web-ci"] = [run(40, "failure", "2026-11-21T13:05:00Z", { headSha: "m".repeat(40) })];
  await verifyWeb(deps());
  let i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "pr-open");
  assert.equal((i.result as { pr: { kind: string } }).pr.kind, "revert");
  pr = { ...pr, state: "MERGED", mergeSha: "r".repeat(40) };
  await advanceWebPrs(deps());
  i = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(i.status, "reverted");
  assert.equal(notes.filter((n) => n.type === "seo-repair-reverted").length, 1);
});

test("web: el mensaje de commit pierde prefijos de convención y nunca empieza por seo(", async () => {
  const { safeCommitMessage } = await import("../contract");
  assert.equal(safeCommitMessage("fix: safehttpurl solo acepta http y https", "ci"), "safehttpurl solo acepta http y https");
  assert.equal(safeCommitMessage("seo(abc12345): cambia el titulo", "ci"), "repara ci");
});

test("web: todas las fuentes vigiladas están declaradas una vez", () => {
  const names = WEB_SOURCES.map((s) => s.component);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes("web-ci") && names.includes("web-deploy") && names.includes("web-health"));
});
