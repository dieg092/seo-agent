// src/repair/repair.test.ts — autorreparación: clasificación, guarda, contrato y supervisor
// con dobles (sin modelo, sin git, sin red; BD de pruebas).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { classifyAlert, incidentKey, signatureOf } from "./classify";
import { guardDiff, parseDiff, type DiffFile } from "./guard";
import { parseReport, safeCommitMessage } from "./contract";
import { checkHeartbeats, ingest, MAX_RUNS_PER_DAY, repairOne, verifyMerged, type SupervisorDeps } from "./supervisor";
import { sanitizeEvidence } from "../../scripts/seo-repair";

const NOW = new Date("2026-11-20T12:00:00Z");
const H = 3_600_000;

// ---------- clasificación ----------

test("clasifica sin modelo: producto se ignora, 503 espera, credencial al fundador, fallo de código se repara", () => {
  assert.equal(classifyAlert({ type: "seo-tick-main-ci", subject: "Web · main abc", body: "El último commit…" }).kind, "ignore");
  assert.equal(classifyAlert({ type: "backlink-new", subject: "Nuevo enlace", body: "" }).kind, "ignore");
  assert.equal(classifyAlert({ type: "seo-repair-escalated", subject: "x", body: "TypeError" }).kind, "ignore");
  assert.equal(classifyAlert({ type: "url-inspection-error", subject: "URL Inspection: 5 URL(s) con error", body: "The service is currently unavailable." }).kind, "transient");
  assert.equal(classifyAlert({ type: "seo-bridge-failed", subject: "El puente ha fallado", body: "PrismaClientInitializationError P1001: Can't reach database server" }).kind, "transient");
  const cred = classifyAlert({ type: "bing-collector-failed", subject: "Bing ha fallado", body: "401 Unauthorized" });
  assert.equal(cred.kind, "founder");
  assert.match(cred.founderStep!, /read -rs/);
  assert.equal(classifyAlert({ type: "seo-ledger-failed", subject: "El registro ha fallado", body: "TypeError: x is not a function" }).kind, "code");
  assert.equal(classifyAlert({ type: "editorial-battery-invalid", subject: "Batería no válida", body: "criterios por debajo de 4" }).kind, "code");
  assert.equal(classifyAlert({ type: "editorial-calibration-inverted", subject: "Calibración", body: "invertida" }).kind, "ignore");
  assert.equal(classifyAlert({ type: "workflow-failed", subject: 'Workflow "daily-collection" tuvo al menos un paso fallido', body: "falló" }).component, "daily-collection");
});

test("la firma no depende de ids, números ni URLs: misma incidencia", () => {
  const a = signatureOf({ type: "seo-ledger-failed", subject: "Fallo", body: "Invalid `prisma.seoChange.findUnique()` id 3f0dc9de-c0fd-401c-8259-c776c0e8aeb8 en https://miwebdeboda.com/x 12 veces" });
  const b = signatureOf({ type: "seo-ledger-failed", subject: "Fallo", body: "Invalid `prisma.seoChange.findUnique()` id 5be25fb7-2147-4249-afc4-e3a0759874aa en https://miwebdeboda.com/y 3 veces" });
  assert.equal(a, b);
  assert.notEqual(incidentKey("seo-ledger-failed", "seo-ledger", a), incidentKey("seo-bridge-failed", "seo-bridge", a));
});

test("la evidencia sale sin URLs de BD, tokens ni rutas personales", () => {
  const out = sanitizeEvidence("conecta a postgresql://u:p@host/db con token=abc123secretvalue y Bearer xyz en /Users/alguien/x.ts ghp_" + "a".repeat(40));
  assert.doesNotMatch(out, /postgresql:\/\//);
  assert.doesNotMatch(out, /abc123secretvalue|xyz|\/Users\/alguien|a{40}/);
});

// ---------- guarda del diff ----------

const file = (path: string, over: Partial<DiffFile> = {}): DiffFile => ({ path, status: "M", added: 3, deleted: 1, addedLines: ["const x = 1;"], ...over });

test("guarda: acepta un arreglo normal con test añadido", () => {
  assert.deepEqual(guardDiff([file("src/tick/events.ts"), file("src/tick/events.test.ts", { deleted: 0, addedLines: ["  assert.equal(f(1), 2);"] })]), { ok: true });
});

test("guarda: rechaza rutas protegidas, borrar tests, saltarlos, umbrales, secretos, borrados y enlaces", () => {
  const bad = (f: DiffFile) => {
    const r = guardDiff([f]);
    assert.equal(r.ok, false, f.path);
  };
  bad(file("prisma/schema.prisma"));
  bad(file("package.json"));
  bad(file(".github/workflows/ci.yml"));
  bad(file("src/editorial/rubric.ts"));
  bad(file("src/editorial/fixtures/validationCases.ts"));
  bad(file("src/repair/supervisor.ts"));
  bad(file("scripts/seo-export.ts"));
  bad(file("src/privacy/outboundPolicy.ts"));
  bad(file("src/tick/events.test.ts", { deleted: 2 }));
  bad(file("src/tick/events.test.ts", { deleted: 0, addedLines: ['test.skip("x", () => {});'] }));
  bad(file("src/editorial/battery.ts", { addedLines: ["export const MAX_QUALITY_ATTEMPTS = 9;"] }));
  bad(file("src/collectors/x.ts", { addedLines: ['const apiKey = "sk-1234567890abcdefgh";'] }));
  bad(file("src/collectors/x.ts", { status: "D" }));
  bad(file("src/collectors/x.ts", { status: "A", mode: "120000" }));
  assert.equal(guardDiff([]).ok, false);
  assert.equal(guardDiff(Array.from({ length: 9 }, (_, i) => file(`src/a${i}.ts`))).ok, false);
  assert.equal(guardDiff([file("src/a.ts", { added: 400 })]).ok, false);
});

test("parseDiff lee numstat, estado, líneas añadidas y modo de los ficheros nuevos", () => {
  const files = parseDiff(
    "2\t0\tsrc/a.ts\n1\t0\tsrc/l.ts\n",
    "M\tsrc/a.ts\nA\tsrc/l.ts\n",
    "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n+uno\n+dos\ndiff --git a/src/l.ts b/src/l.ts\nnew file mode 120000\n--- /dev/null\n+++ b/src/l.ts\n@@ -0,0 +1 @@\n+../x\n"
  );
  assert.deepEqual(files[0].addedLines, ["uno", "dos"]);
  assert.equal(files[1].status, "A");
  assert.equal(files[1].mode, "120000");
  assert.equal(guardDiff(files).ok, false);
});

// ---------- contrato ----------

const REPORT = { veredicto: "reparado", diagnostico: "faltaba reintento", cambios: [{ ruta: "src/a.ts", motivo: "reintento" }], tests: [{ comando: "npx tsc --noEmit -p .", resultado: "aprobado", detalle: "" }], paso_fundador: null, commit: "reintenta la inspeccion ante 503" };

test("contrato: toma el último JSON válido y rechaza campos de más o valores fuera de lista", () => {
  assert.equal(parseReport(`he hecho cosas {no json}\n${JSON.stringify(REPORT)}`)?.veredicto, "reparado");
  assert.equal(parseReport(JSON.stringify({ ...REPORT, extra: 1 })), null);
  assert.equal(parseReport(JSON.stringify({ ...REPORT, veredicto: "hecho" })), null);
  assert.equal(parseReport(JSON.stringify({ ...REPORT, tests: [{ comando: "x", resultado: "ok", detalle: "" }] })), null);
  assert.equal(parseReport("sin json"), null);
});

test("mensaje de commit: corto, en minúsculas y sin rastro de IA; si no, uno neutro", () => {
  assert.equal(safeCommitMessage("reintenta la inspeccion ante 503", "x"), "reintenta la inspeccion ante 503");
  assert.equal(safeCommitMessage("Fix generado por Claude", "url-inspection"), "repara url-inspection");
  assert.equal(safeCommitMessage(null, "seo-bridge"), "repara seo-bridge");
});

// ---------- supervisor (BD de pruebas, dobles) ----------

const notes: { type: string; subject: string }[] = [];
let clock = NOW;
let published = 0;
let reverted = 0;
let agentCalls = 0;

function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
  return {
    now: () => clock,
    notify: async (a) => {
      notes.push(a);
    },
    reserve: async () => {},
    createWorkspace: () => ({ dir: "/tmp/no-se-usa", baseSha: "a".repeat(40), dispose: () => {} }),
    runAgent: async () => {
      agentCalls += 1;
      return { ok: true, text: JSON.stringify(REPORT), denials: [] };
    },
    diff: () => [file("src/collectors/urlInspectionCollector.ts"), file("src/collectors/urlInspectionCollector.test.ts", { deleted: 0, addedLines: ["assert.ok(true);"] })],
    gate: () => ({ ok: true, detail: "typecheck ok, 560 tests ok" }),
    publish: () => {
      published += 1;
      return { prUrl: "https://github.com/dieg092/seo-agent/pull/1", mergedSha: "b".repeat(40) };
    },
    revert: () => {
      reverted += 1;
      return { prUrl: "https://github.com/dieg092/seo-agent/pull/2", mergedSha: "c".repeat(40) };
    },
    updateMain: () => ({ ok: true }),
    evidence: () => "Aviso: TypeError",
    kickstart: () => true,
    ...over,
  };
}

const codeAlert = (at: Date, body = "TypeError: cannot read properties of undefined") => ({ type: "seo-ledger-failed", subject: "El registro de cambios SEO ha fallado", body, createdAt: at });

beforeEach(async () => {
  notes.length = 0;
  clock = NOW;
  published = reverted = agentCalls = 0;
  await prisma.repairIncident.deleteMany({});
  await prisma.workflowHeartbeat.deleteMany({});
});
after(async () => {
  await prisma.repairIncident.deleteMany({});
  await prisma.$disconnect();
});

test("avisos repetidos del mismo fallo son UNA incidencia; los de producto no crean nada", async () => {
  await ingest([codeAlert(NOW), codeAlert(new Date(NOW.getTime() + 1000)), { type: "backlink-new", subject: "x", body: "", createdAt: NOW }], deps());
  const rows = await prisma.repairIncident.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occurrences, 2);
  assert.equal(rows[0].status, "open");
});

test("credencial rechazada: aviso al fundador UNA vez con el paso, sin gastar modelo", async () => {
  const a = { type: "bing-collector-failed", subject: "Bing ha fallado", body: "401 Unauthorized", createdAt: NOW };
  await ingest([a, { ...a, createdAt: new Date(NOW.getTime() + H) }], deps());
  assert.equal(notes.filter((n) => n.type === "seo-repair-founder").length, 1);
  assert.equal(await repairOne("/tmp", deps()), "reparación: nada pendiente");
  assert.equal(agentCalls, 0);
});

test("transitorio que se repite durante horas pasa a reparable", async () => {
  const t = (h: number) => ({ type: "url-inspection-error", subject: "URL Inspection con error", body: "The service is currently unavailable.", createdAt: new Date(NOW.getTime() + h * H) });
  await ingest([t(0), t(1)], deps());
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).kind, "transient");
  await ingest([t(4), t(7)], deps());
  const row = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(row.kind, "code");
  assert.equal(row.status, "open");
});

test("reparación completa: agente → guarda → puerta → PR fusionado → verificación → resuelta", async () => {
  await ingest([codeAlert(NOW)], deps());
  const line = await repairOne("/tmp", deps());
  assert.match(line, /reparado/);
  assert.equal(published, 1);
  let row = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(row.status, "verifying");
  assert.equal(row.mergedSha, "b".repeat(40));
  // dentro de la ventana no se da por resuelta
  clock = new Date(NOW.getTime() + H);
  await verifyMerged(deps());
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).status, "verifying");
  clock = new Date(NOW.getTime() + 80 * H);
  await verifyMerged(deps());
  row = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(row.status, "resolved");
  assert.ok(notes.some((n) => n.type === "seo-repair-fixed"));
});

test("fallo NUEVO en el mismo componente tras fusionar: se revierte el commit exacto", async () => {
  await ingest([codeAlert(NOW)], deps());
  await repairOne("/tmp", deps());
  clock = new Date(NOW.getTime() + H);
  await ingest([codeAlert(clock, "RangeError: invalid time value")], deps());
  await verifyMerged(deps());
  assert.equal(reverted, 1);
  const first = await prisma.repairIncident.findFirstOrThrow({ where: { mergedSha: "b".repeat(40) } });
  assert.equal(first.status, "reverted");
  assert.ok(notes.some((n) => n.type === "seo-repair-reverted"));
});

test("el mismo fallo vuelve tras fusionar: se reabre con espera, y al agotar intentos se escala", async () => {
  await ingest([codeAlert(NOW)], deps());
  await repairOne("/tmp", deps());
  clock = new Date(NOW.getTime() + H);
  await ingest([codeAlert(clock)], deps());
  await verifyMerged(deps());
  let row = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(row.status, "open");
  assert.equal(await repairOne("/tmp", deps()), "reparación: nada pendiente", "respeta las 6 h de espera");
  clock = new Date(NOW.getTime() + 8 * H);
  await repairOne("/tmp", deps());
  clock = new Date(NOW.getTime() + 9 * H);
  await ingest([codeAlert(clock)], deps());
  await verifyMerged(deps());
  row = await prisma.repairIncident.findFirstOrThrow();
  assert.equal(row.status, "escalated");
  assert.equal(agentCalls, 2);
});

test("diff que toca algo prohibido: no se publica y se reintenta una vez; luego se escala", async () => {
  const d = deps({ diff: () => [file("src/editorial/rubric.ts")] });
  await ingest([codeAlert(NOW)], d);
  assert.match(await repairOne("/tmp", d), /guarda/);
  assert.equal(published, 0);
  clock = new Date(NOW.getTime() + 7 * H);
  await repairOne("/tmp", d);
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).status, "escalated");
  assert.ok(notes.some((n) => n.type === "seo-repair-escalated"));
});

test("JSON inválido, puerta local roja o agente caído: nunca se publica", async () => {
  for (const over of [
    { runAgent: async () => ({ ok: true, text: "listo, ya está", denials: [] }) },
    { gate: () => ({ ok: false, detail: "tests: 1 fallan" }) },
    { runAgent: async () => ({ ok: false, text: "", denials: [], error: "claude sin resultado" }) },
  ] as Partial<SupervisorDeps>[]) {
    await prisma.repairIncident.deleteMany({});
    await ingest([codeAlert(NOW)], deps(over));
    await repairOne("/tmp", deps(over));
  }
  assert.equal(published, 0);
});

test("«necesita_fundador» sin cambios: aviso con el paso; dice reparado pero dice otra cosa con diff: no se publica", async () => {
  const need = deps({ runAgent: async () => ({ ok: true, text: JSON.stringify({ ...REPORT, veredicto: "necesita_fundador", paso_fundador: "renueva la clave de Bing", commit: null }), denials: [] }), diff: () => [] });
  await ingest([codeAlert(NOW)], need);
  await repairOne("/tmp", need);
  assert.ok(notes.some((n) => n.type === "seo-repair-founder"));
  await prisma.repairIncident.deleteMany({});
  const liar = deps({ runAgent: async () => ({ ok: true, text: JSON.stringify({ ...REPORT, veredicto: "sin_cambio", commit: null }), denials: [] }) });
  await ingest([codeAlert(NOW)], liar);
  assert.match(await repairOne("/tmp", liar), /incoherente/);
  assert.equal(published, 0);
});

test("límites: sin presupuesto no llama; como mucho 2 ejecuciones al día; una reparación a la vez", async () => {
  await ingest([codeAlert(NOW)], deps());
  assert.match(await repairOne("/tmp", deps({ reserve: async () => { throw new Error("Órbita está usando el modelo"); } })), /aplazada/);
  assert.equal(agentCalls, 0);
  const failing = deps({ gate: () => ({ ok: false, detail: "rojo" }) });
  for (let i = 0; i < 4; i++) await ingest([codeAlert(NOW, `Error${i}: distinto ${"x".repeat(i + 1)}`)], failing);
  for (let i = 0; i < 5; i++) await repairOne("/tmp", failing);
  assert.equal(agentCalls, MAX_RUNS_PER_DAY);
  await prisma.repairIncident.updateMany({ data: { status: "open", nextAttemptAt: null } });
  const one = await prisma.repairIncident.findFirstOrThrow();
  await prisma.repairIncident.update({ where: { id: one.id }, data: { status: "running" } });
  assert.equal(await repairOne("/tmp", deps()), "reparación: hay otra en curso");
});

test("heartbeat atrasado del Mac: se relanza; si sigue sin latir, aviso único", async () => {
  await prisma.workflowHeartbeat.create({ data: { workflowName: "seo-bridge", lastStatus: "ok", lastRunAt: new Date(NOW.getTime() - 3 * H) } });
  let kicks = 0;
  const d = deps({ kickstart: () => (kicks += 1, true) });
  await checkHeartbeats(d);
  assert.equal(kicks, 1);
  assert.equal(notes.length, 0);
  clock = new Date(NOW.getTime() + H);
  await checkHeartbeats(d);
  await checkHeartbeats(d);
  assert.equal(kicks, 1);
  assert.equal(notes.filter((n) => n.type === "seo-repair-founder").length, 1);
  // vuelve a latir: se cierra
  await prisma.workflowHeartbeat.update({ where: { workflowName: "seo-bridge" }, data: { lastRunAt: clock } });
  await checkHeartbeats(d);
  assert.equal((await prisma.repairIncident.findFirstOrThrow()).status, "resolved");
});
