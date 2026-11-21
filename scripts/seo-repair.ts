// scripts/seo-repair.ts
// Pasada del supervisor de autorreparación (LaunchAgent com.miwebdeboda.seo-repair, cada 5 min).
// Ver src/repair/supervisor.ts. Interruptor: si existe ~/.seo-repair/OFF no hace nada.
// Uso manual: tsx scripts/seo-repair.ts [--no-repair]   (--no-repair: solo ingesta y verificación)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db";
import { recordAlert } from "../src/alerts/recordAlert";
import { reserveCall } from "../src/editorial/budget";
import { redactText } from "../src/privacy/outboundPolicy";
import { checkHeartbeats, ingest, recoverStale, repairOne, resolveWithoutModel, verifyMerged, type SupervisorDeps } from "../src/repair/supervisor";
import { childEnv, createWorkspace, fileTail, ghFailedLog, localGate, publish, revertCommit, updateMainCheckout, workspaceDiff } from "../src/repair/git";
import { runSandboxedAgent, WEB_REPAIR_ALLOWED } from "../src/repair/sandbox";
import { advanceWebPrs, observeWeb, repairWeb, verifyWeb, type WebCursor, type WebDeps } from "../src/repair/web/supervisor";
import { branchCiRun, closePr, dispatchCi, listRuns, mergePr, prState, pushPr, retryRun, revertInto, runFailure, updateBranch, webGate } from "../src/repair/web/github";
import { protectedMatcher } from "../src/repair/web/guard";

const MAIN_DIR = join(__dirname, "..");
const STATE_DIR = join(homedir(), ".seo-repair");
const LOCK = join(STATE_DIR, "lock");
const STATE = join(STATE_DIR, "state.json");
const OFF = join(STATE_DIR, "OFF");
/** Web: WEB_OFF apaga la parte web; WEB_OBSERVE la deja solo observando (sin modelo ni publicación). */
const WEB_OFF = join(STATE_DIR, "WEB_OFF");
const WEB_OBSERVE = join(STATE_DIR, "WEB_OBSERVE");
const WEB_CURSOR = join(STATE_DIR, "web-cursor.json");
const WI2_DIR = join(MAIN_DIR, "..", "wedding-invite-2");
const PROTECTED_LIST = join(homedir(), "Projects/infra/miwebdeboda-deploy/protegido.txt");

function webDeps(base: SupervisorDeps): WebDeps {
  // Sin la lista de protegidos de la puerta de despliegue, todo cuenta como protegido (falla cerrado).
  const isProtected = existsSync(PROTECTED_LIST) ? protectedMatcher(readFileSync(PROTECTED_LIST, "utf8")) : () => true;
  return {
    now: base.now,
    notify: base.notify,
    reserve: base.reserve,
    runs: (s) => listRuns(s),
    failure: runFailure,
    retry: retryRun,
    createWorkspace: () => createWorkspace(WI2_DIR),
    runAgent: (dir, prompt) => runSandboxedAgent(dir, prompt, 20 * 60_000, WEB_REPAIR_ALLOWED),
    diff: workspaceDiff,
    gate: webGate,
    isProtected,
    pushPr,
    pr: prState,
    updateBranch,
    dispatchCi,
    branchCi: branchCiRun,
    merge: mergePr,
    close: closePr,
    revertInto,
  };
}

async function webPass(base: SupervisorDeps, seoLine: string): Promise<string> {
  if (existsSync(WEB_OFF)) return "web: apagada (~/.seo-repair/WEB_OFF)";
  const observeOnly = existsSync(WEB_OBSERVE);
  const deps = webDeps(base);
  const cursor: WebCursor = existsSync(WEB_CURSOR) ? JSON.parse(readFileSync(WEB_CURSOR, "utf8")) : {};
  const obs = await observeWeb(cursor, observeOnly ? { ...deps, retry: () => false } : deps);
  const tmp = `${WEB_CURSOR}.tmp`;
  writeFileSync(tmp, JSON.stringify(obs.cursor));
  renameSync(tmp, WEB_CURSOR);
  for (const l of obs.log) console.log(`seo-repair web: ${l}`);
  if (observeOnly) return "web: solo observación (~/.seo-repair/WEB_OBSERVE)";
  for (const l of await advanceWebPrs(deps)) console.log(`seo-repair web: ${l}`);
  for (const l of await verifyWeb(deps)) console.log(`seo-repair web: ${l}`);
  // Una sola ejecución del modelo por pasada: la web solo si seo-agent no tenía nada que reparar.
  if (process.argv.includes("--no-repair") || !/nada pendiente/.test(seoLine)) return "web: sin reparar en esta pasada";
  return repairWeb(deps);
}

/** Evidencia saneada para el agente: sin URLs de BD, tokens largos ni rutas personales. */
export function sanitizeEvidence(text: string): string {
  return redactText(text)
    .replace(/postgres(ql)?:\/\/\S+/gi, "<url-bd>")
    .replace(/\b(Bearer|token|key|secret|password)[=: ]+\S+/gi, "$1 <redactado>")
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, "<redactado>")
    .replace(new RegExp(MAIN_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/?", "g"), "")
    .replace(/\/Users\/[^\s'"`)]+/g, "<ruta>")
    .replace(/^\S+\t\S+\t\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
}

const evidenceWith = (runUrls: Record<string, string>) => (component: string, alertType: string, alertText: string): string => {
  const parts = [`Aviso:\n${alertText}`];
  // heartbeat de GitHub → URL de la ejecución → log de los pasos fallidos
  const url = runUrls[component];
  if (url && /actions\/runs\//.test(url)) {
    const log = ghFailedLog(url);
    if (log) parts.push(`Log de los pasos fallidos (últimas líneas):\n${log.split("\n").slice(-150).join("\n")}`);
  }
  const local = fileTail(join(homedir(), "Library/Logs", `${component}.log`), 80);
  if (local) parts.push(`Log local (${component}.log, últimas líneas):\n${local}`);
  return sanitizeEvidence(parts.join("\n\n")).slice(0, 12_000);
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    if (pid && pidAlive(pid)) return false;
  }
  writeFileSync(LOCK, String(process.pid));
  return true;
}

async function main() {
  if (existsSync(OFF)) return console.log("seo-repair: apagado (~/.seo-repair/OFF)");
  if (!acquireLock()) return console.log("seo-repair: otra pasada en curso");
  try {
    const now = new Date();
    const state: { cursor?: string } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
    const cursor = state.cursor ? new Date(state.cursor) : new Date(now.getTime() - 24 * 3_600_000);
    const alerts = await prisma.alert.findMany({ where: { createdAt: { gt: cursor } }, orderBy: { createdAt: "asc" }, take: 500 });

    const hbs = await prisma.workflowHeartbeat.findMany();
    const runUrls = Object.fromEntries(hbs.filter((h) => h.lastRunUrl).map((h) => [h.workflowName, h.lastRunUrl!]));

    const deps: SupervisorDeps = {
      now: () => new Date(),
      notify: recordAlert,
      reserve: (n) => reserveCall("background", n),
      createWorkspace: () => createWorkspace(MAIN_DIR),
      runAgent: runSandboxedAgent,
      diff: workspaceDiff,
      gate: localGate,
      publish,
      revert: (sha, branch, msg) => revertCommit(MAIN_DIR, sha, branch, msg),
      updateMain: () => updateMainCheckout(MAIN_DIR),
      evidence: evidenceWith(runUrls),
      pendingMigrations: () => {
        try {
          execFileSync("npx", ["prisma", "migrate", "status"], { cwd: MAIN_DIR, stdio: "ignore", timeout: 120_000, env: childEnv() });
          return false;
        } catch {
          return true; // sale con 1 si hay migraciones pendientes (o si no puede comprobarlo: migrate deploy decide)
        }
      },
      migrate: () => {
        try {
          execFileSync("pnpm", ["-s", "db:migrate"], { cwd: MAIN_DIR, stdio: "ignore", timeout: 300_000, env: childEnv() });
          return { ok: true, detail: "migraciones aplicadas con pnpm db:migrate" };
        } catch (e) {
          return { ok: false, detail: redactText(String((e as Error).message)).slice(0, 300) };
        }
      },
      kickstart: (label) => {
        try {
          execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${label}`], { stdio: "ignore", timeout: 30_000 });
          return true;
        } catch {
          return false;
        }
      },
    };

    await recoverStale(deps);
    const touched = await ingest(alerts.map((a) => ({ type: a.type, subject: a.subject, body: a.body, createdAt: a.createdAt })), deps);
    if (alerts.length) {
      const tmp = `${STATE}.tmp`;
      writeFileSync(tmp, JSON.stringify({ cursor: alerts[alerts.length - 1].createdAt.toISOString() }));
      renameSync(tmp, STATE);
    } else if (!state.cursor) writeFileSync(STATE, JSON.stringify({ cursor: now.toISOString() }));
    await checkHeartbeats(deps);
    for (const l of await resolveWithoutModel(deps)) console.log(`seo-repair: ${l}`);
    for (const l of await verifyMerged(deps)) console.log(`seo-repair: ${l}`);
    const line = process.argv.includes("--no-repair") ? "reparación: desactivada en esta pasada" : await repairOne(MAIN_DIR, deps);
    let webLine: string;
    try {
      webLine = await webPass(deps, line);
    } catch (e) {
      webLine = `web: error (${redactText(String((e as Error).message)).slice(0, 200)})`;
    }
    console.log(`${now.toISOString()} seo-repair: ${alerts.length} avisos nuevos, ${touched} de sistema; ${line}; ${webLine}`);
    // Latido propio: el vigilante de GitHub (self-health-watchdog) avisa si el Mac deja de pasar por aquí.
    await prisma.workflowHeartbeat.upsert({ where: { workflowName: "seo-repair" }, create: { workflowName: "seo-repair", lastStatus: "ok", lastRunAt: new Date() }, update: { lastStatus: "ok", lastRunAt: new Date() } });
  } finally {
    try {
      unlinkSync(LOCK);
    } catch {
      // ya no estaba
    }
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error("seo-repair falló:", redactText(String(e?.stack ?? e)).slice(0, 2000));
    try {
      const recent = await prisma.alert.findFirst({ where: { type: "seo-repair-crashed", createdAt: { gt: new Date(Date.now() - 6 * 3_600_000) } } });
      if (!recent) await recordAlert({ type: "seo-repair-crashed", subject: "El supervisor de autorreparación ha fallado", body: redactText(String(e?.message ?? e)).slice(0, 500) });
    } catch {
      // sin BD tampoco hay aviso
    }
    process.exit(1);
  });
}
