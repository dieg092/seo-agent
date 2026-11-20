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
import { checkHeartbeats, ingest, recoverStale, repairOne, verifyMerged, type SupervisorDeps } from "../src/repair/supervisor";
import { createWorkspace, fileTail, ghFailedLog, localGate, publish, revertCommit, updateMainCheckout, workspaceDiff } from "../src/repair/git";
import { runSandboxedAgent } from "../src/repair/sandbox";

const MAIN_DIR = join(__dirname, "..");
const STATE_DIR = join(homedir(), ".seo-repair");
const LOCK = join(STATE_DIR, "lock");
const STATE = join(STATE_DIR, "state.json");
const OFF = join(STATE_DIR, "OFF");

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
    for (const l of await verifyMerged(deps)) console.log(`seo-repair: ${l}`);
    const line = process.argv.includes("--no-repair") ? "reparación: desactivada en esta pasada" : await repairOne(MAIN_DIR, deps);
    console.log(`${now.toISOString()} seo-repair: ${alerts.length} avisos nuevos, ${touched} de sistema; ${line}`);
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
