// scripts/audit-runtime.ts
// Auditoría final reproducible (plan de autonomía, parte B): ¿está todo corriendo como debe?
// Solo lee: no ejecuta colectores ni cambia datos. La salida es agregada (sin URLs privadas,
// consultas ni nombres). Resultado por comprobación: pass, pending (falta tiempo o datos),
// fail. Sale con 1 si alguna obligatoria falla.
//   tsx scripts/audit-runtime.ts            (todo)
//   tsx scripts/audit-runtime.ts --tests    (además, la batería de tests en la BD de pruebas)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db";
import { AUTO_OPERATIONS, buildContract, renderDescription, renderPrompt, taskTitle } from "../src/bridge/contract";
import { semanticScope } from "../src/bridge/semanticScope";
import { containsPrivate } from "../src/privacy/outboundPolicy";
import { CALIBRATION_MAX_AGE_DAYS } from "../src/editorial/gate";
import { MIN_VALIDITY_N } from "../src/editorial/calibration";
import { batteryKey, batteryState } from "../src/editorial/battery";
import { EDITORIAL_DAILY_BACKGROUND, EDITORIAL_DAILY_GUARD, budgetToday } from "../src/editorial/budget";
import { PILOT_MAX_OPEN, pilotHasRoom } from "../src/editorial/pilot";
import { NO_DEPLOY_ALERT_HOURS } from "../src/graduation/changeLedger";

// info: se informa, pero no es un objetivo que pueda fallar (p. ej., el diagnóstico ρ).
type Status = "pass" | "pending" | "info" | "fail";
const results: { area: string; check: string; status: Status; detail: string }[] = [];
const add = (area: string, check: string, status: Status, detail = ""): void => void results.push({ area, check, status, detail });
const DAY = 24 * 3600_000;
const now = Date.now();

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? "");
  }
}

function launchAgent(label: string): void {
  const out = sh("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${label}`]);
  if (!out) return add("procesos", `LaunchAgent ${label}`, "fail", "no está cargado");
  const state = /\bstate = (\S+)/.exec(out)?.[1] ?? "?";
  const lastExit = /last exit code = (\S+)/.exec(out)?.[1] ?? "-";
  add("procesos", `LaunchAgent ${label}`, "pass", `estado ${state}, última salida ${lastExit}`);
}

function logFresh(name: string, path: string, maxMinutes: number): void {
  if (!existsSync(path)) return add("procesos", `log ${name}`, "fail", "no existe");
  const ageMin = Math.round((now - statSync(path).mtimeMs) / 60_000);
  add("procesos", `log ${name} reciente`, ageMin <= maxMinutes ? "pass" : "fail", `hace ${ageMin} min (máx. ${maxMinutes})`);
}

async function main(): Promise<number> {
  // 1. Procesos
  launchAgent("com.miwebdeboda.seo-bridge");
  launchAgent("com.orbita.worker");
  logFresh("del puente", join(homedir(), "Library/Logs/seo-bridge.log"), 45);
  const worker = sh("pgrep", ["-f", "copy-worker.ts"]);
  add("procesos", "trabajador de Órbita en marcha", worker ? "pass" : "fail", worker ? `${worker.split("\n").length} procesos` : "no corre");
  const bridgeLog = existsSync(join(homedir(), "Library/Logs/seo-bridge.log")) ? readFileSync(join(homedir(), "Library/Logs/seo-bridge.log"), "utf8").split("\n").slice(-400) : [];
  const lastPass = bridgeLog.filter((l) => / puente: /.test(l)).pop();
  add("procesos", "última pasada del puente", lastPass ? "pass" : "fail", lastPass ? lastPass.slice(0, 24) : "sin pasadas en el log");

  // 2. Control y freno
  const control = await prisma.seoControl.findUnique({ where: { id: "global" } });
  add("frenos", "interruptor maestro", control?.masterSwitch === "on" ? "pass" : "fail", control?.masterSwitch ?? "sin fila");
  add("frenos", "freno automático", control?.brakeState === "off" ? "pass" : "fail", control?.brakeState === "off" ? "suelto" : `echado: ${control?.brakeReason ?? "?"}`);

  // 3. IA editorial
  const cal = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  if (!cal) add("editorial", "calibración", "fail", "no hay");
  else {
    const age = (now - cal.createdAt.getTime()) / DAY;
    add("editorial", "calibración en verde y vigente", cal.status === "ok" && age <= CALIBRATION_MAX_AGE_DAYS ? "pass" : "fail", `${cal.status}, hace ${age.toFixed(1)} días`);
    const n = cal.validityN ?? 0;
    add("editorial", "diagnóstico nota–GSC entre artículos (no autoriza)", "info", `n=${n}/${MIN_VALIDITY_N}, ρ=${cal.validityRho ?? "indefinido"}`);
  }
  const battery = await batteryState(new Date(now));
  const run = await prisma.editorialBatteryRun.findFirst({ where: { configKey: batteryKey(), status: "running" } });
  const progress = run ? `${await prisma.editorialBatteryCaseResult.count({ where: { runId: run.id } })}/20 casos, intento ${run.attempt}, ${run.quotaHits} límites de cupo, ${run.transientFails} errores seguidos${run.nextAttemptAt ? `, sigue a partir de ${run.nextAttemptAt.toISOString()}` : ""}` : "";
  add(
    "editorial",
    "batería de defectos aprobada y vigente",
    battery.status === "ok" ? "pass" : battery.status === "missing" || battery.status === "running" ? "pending" : "fail",
    battery.status === "ok" ? `del ${battery.at.toISOString().slice(0, 10)}` : `${battery.reason}${progress ? ` (${progress})` : ""}`,
  );
  const budget = await budgetToday(new Date(now));
  add("editorial", "presupuesto de llamadas de hoy", "info", `fondo ${budget.background}/${EDITORIAL_DAILY_BACKGROUND}, guardas ${budget.guard}/${EDITORIAL_DAILY_GUARD}${budget.quotaUntil ? `, cupo agotado hasta ${budget.quotaUntil.toISOString()}` : ""}`);
  const pilots = await prisma.editorialPilot.groupBy({ by: ["state"], _count: true });
  const open = pilots.filter((p) => ["reserved", "observing"].includes(p.state)).reduce((x, p) => x + p._count, 0);
  const room = await pilotHasRoom(new Date(now));
  add("editorial", "piloto editorial operativo (sin bloqueo indefinido)", "pass", `${open}/${PILOT_MAX_OPEN} abiertos, ${room ? "con plaza" : "sin plaza ahora (se libera sola)"}; ${pilots.map((p) => `${p.state}: ${p._count}`).join(", ") || "sin pilotos aún"}`);
  const evaluable = pilots.filter((p) => ["positive", "negative", "neutral"].includes(p.state)).reduce((x, p) => x + p._count, 0);
  add("editorial", "impacto medido de las mejoras de artículos", evaluable > 0 ? "pass" : "pending", `${evaluable} pilotos evaluables`);
  const scored = await prisma.editorialScore.count({ where: { kind: "routine", createdAt: { gte: new Date(now - DAY) } } });
  add("editorial", "evaluaciones en las últimas 24 h", scored > 0 ? "pass" : "pending", `${scored}`);

  // 4. Registro de cambios y medición
  const doneA1 = await prisma.seoTaskLink.findMany({ where: { autonomy: "A1", closeReason: "done" } });
  const autoDone = doneA1.filter((l) => (l.contract as { publishPolicy?: string } | null)?.publishPolicy === "auto-merge-if-green");
  const inLedger = await prisma.seoChange.count({ where: { orbitaTaskId: { in: autoDone.map((l) => l.orbitaTaskId) } } });
  add("medición", "cada cambio automático está en el registro", inLedger === autoDone.length ? "pass" : "fail", `${inLedger}/${autoDone.length}`);
  const revertStuck = await prisma.seoChange.count({ where: { status: "revert-failed" } });
  add("medición", "ninguna reversión fallida", revertStuck === 0 ? "pass" : "fail", `${revertStuck}`);
  const stuck = await prisma.seoChange.count({ where: { status: "pending-deploy", createdAt: { lt: new Date(now - NO_DEPLOY_ALERT_HOURS * 3600_000) } } });
  add("medición", "ningún cambio fusionado sin desplegar > 24 h", stuck === 0 ? "pass" : "fail", `${stuck}`);
  const byStatus = await prisma.seoChange.groupBy({ by: ["status"], _count: true });
  const measured = byStatus.find((s) => s.status === "measured")?._count ?? 0;
  add("medición", "primera medición real a 28 días", measured > 0 ? "pass" : "pending", byStatus.map((s) => `${s.status}: ${s._count}`).join(", "));

  // 5. Privacidad: nada privado en lo que el puente mandaría ni en los avisos de la última semana
  const opps = await prisma.opportunity.findMany({ where: { status: { in: ["open", "detected", "in_progress"] } } });
  let leaks = 0;
  for (const o of opps) {
    const c = buildContract({ id: o.id, stableKey: o.stableKey, findingType: o.findingType, title: o.title, detail: o.detail, page: o.page, operation: o.operation, autonomy: o.autonomy, lane: o.lane, severity: o.severity } as never, { now: new Date(), changeId: "audit" });
    if (containsPrivate({ t: taskTitle(c), d: renderDescription(c), p: renderPrompt(c), c })) leaks += 1;
  }
  add("privacidad", "salida del puente sin datos privados", leaks === 0 ? "pass" : "fail", `${leaks} de ${opps.length} oportunidades`);
  const alerts = await prisma.alert.findMany({ where: { createdAt: { gte: new Date(now - 7 * DAY) } }, select: { subject: true, body: true } });
  const alertLeaks = alerts.filter((a) => containsPrivate(a)).length;
  add("privacidad", "avisos de la semana sin datos privados", alertLeaks === 0 ? "pass" : "fail", `${alertLeaks} de ${alerts.length}`);

  // 6. Guardas: toda operación automática tiene regla de alcance
  const noRule = [...AUTO_OPERATIONS].filter((op) => {
    const r = semanticScope(op, [{ path: "x", base: "a\n", head: "b\n" }], []);
    return !r.ok && /no tiene comprobación/.test(r.reason);
  });
  add("guardas", "operaciones automáticas con regla de alcance", noRule.length === 0 ? "pass" : "fail", noRule.length ? noRule.join(", ") : `${AUTO_OPERATIONS.size} operaciones`);
  const guardCmd = existsSync(join(__dirname, "seo-guard.sh"));
  add("guardas", "guarda del trabajador instalada", guardCmd ? "pass" : "fail", "scripts/seo-guard.sh");

  // 7. Despliegue
  const runs = sh("gh", ["run", "list", "-R", "dieg092/miwebdeboda-deploy", "-w", "deploy.yml", "-L", "10", "--json", "conclusion,createdAt"]);
  try {
    const list = JSON.parse(runs) as { conclusion: string; createdAt: string }[];
    const lastOk = list.find((r) => r.conclusion === "success");
    add("despliegue", "último despliegue correcto", lastOk ? "pass" : "fail", lastOk ? lastOk.createdAt : "ninguno en los 10 últimos");
  } catch {
    add("despliegue", "último despliegue correcto", "fail", "no se puede leer GitHub");
  }
  const lastDeploy = await prisma.deployEvent.findFirst({ orderBy: { deployedAt: "desc" } });
  add("despliegue", "seo-agent registra los despliegues", lastDeploy && now - lastDeploy.deployedAt.getTime() < 7 * DAY ? "pass" : "fail", lastDeploy ? lastDeploy.deployedAt.toISOString() : "sin registros");

  // 8. Avisos sin atender
  // Un aviso grave es fallo si se repite o si no hubo recuperación después; uno suelto ya
  // recuperado (o causado por Google caído) se informa, pero no cuenta como fallo.
  const recent = await prisma.alert.groupBy({ by: ["type"], where: { createdAt: { gte: new Date(now - DAY) } }, _count: true, _max: { createdAt: true } });
  const lastPassAt = lastPass ? Date.parse(lastPass.slice(0, 24)) : 0;
  const googleDown = recent.some((r) => r.type === "url-inspection-error");
  const heartbeats = await prisma.workflowHeartbeat.findMany();
  for (const r of recent.filter((x) => /failed|inverted|regression|negative|blocked|private/.test(x.type))) {
    const at = r._max.createdAt?.getTime() ?? 0;
    let status: Status = "fail";
    let why = "sin recuperación";
    if (r._count === 1 && r.type === "seo-bridge-failed" && lastPassAt > at) [status, why] = ["pass", "suelto, el puente ha pasado bien después"];
    if (r._count === 1 && r.type === "workflow-failed" && googleDown) {
      const stillFailed = heartbeats.some((h) => h.lastStatus === "failed" && h.lastRunAt.getTime() > at + 3600_000);
      if (!stillFailed) [status, why] = ["pending", "Google no respondía; se comprueba en la próxima recogida"];
    }
    add("avisos", `aviso ${r.type}`, status, `${r._count} en 24 h, ${why}`);
  }
  add("avisos", "avisos de las últimas 24 h", "pass", recent.map((r) => `${r.type}: ${r._count}`).join(", ") || "ninguno");

  // 9. Tests (opcional): batería completa en la BD de pruebas
  if (process.argv.includes("--tests")) {
    const env = { ...process.env, DATABASE_URL: "", DIRECT_URL: "", BLOG_PHOTOS_DATABASE_URL: "", APP_FUNNEL_DATABASE_URL: "" };
    for (const k of ["DATABASE_URL", "DIRECT_URL", "BLOG_PHOTOS_DATABASE_URL", "APP_FUNNEL_DATABASE_URL"]) delete (env as Record<string, string | undefined>)[k];
    const t = spawnSync("pnpm", ["-s", "test"], { cwd: join(__dirname, ".."), env, encoding: "utf8" });
    const pass = /ℹ pass (\d+)/.exec(t.stdout ?? "")?.[1];
    const fail = /ℹ fail (\d+)/.exec(t.stdout ?? "")?.[1];
    add("tests", "seo-agent: batería completa", fail === "0" ? "pass" : "fail", `${pass ?? "?"} bien, ${fail ?? "?"} mal`);
  }

  const order: Status[] = ["fail", "pending", "info", "pass"];
  for (const r of results.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.area.localeCompare(b.area))) {
    console.log(`${r.status.padEnd(7)} ${r.area.padEnd(11)} ${r.check}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const counts = Object.fromEntries(order.map((s) => [s, results.filter((r) => r.status === s).length]));
  console.log(`\n${counts.pass} pass, ${counts.pending} pending, ${counts.info} info, ${counts.fail} fail`);
  await prisma.$disconnect();
  return counts.fail > 0 ? 1 : 0;
}

main().then((code) => process.exit(code));
