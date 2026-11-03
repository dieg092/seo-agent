// Vigilancia persistente de las tareas SEO de Órbita. La lanza el LaunchAgent
// com.miwebdeboda.seo-tick cada 30 min, sin sesión de Claude. Solo detecta y avisa
// (tabla Alert → panel de admin, y Telegram si hay credenciales): no fusiona, no
// aprueba tareas ni ejecuta IA. Órbita sigue siendo el único orquestador.
//
// - Un lock con PID evita dos ejecuciones a la vez; uno huérfano (PID muerto) se ignora.
// - El estado anterior se guarda en ~/.seo-tick/state.json con escritura atómica.
// - Restaura la copia de spec y plan en la carpeta de datos de Órbita si seo-export la borró.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "../src/db";
import { recordAlert } from "../src/alerts/recordAlert";
import { execFileSync } from "node:child_process";
import { computeEvents, mainCiEvent, nextState, type MainCiSnap, type TaskSnap, type TickState } from "../src/tick/events";

const HOME = homedir();
const STATE_DIR = join(HOME, ".seo-tick");
const LOCK = join(STATE_DIR, "lock");
const STATE = join(STATE_DIR, "state.json");
const ORBITA_ENV = join(HOME, "Projects/personal/orbita/.env.worker");
const DOCS = join(__dirname, "..", "docs", "superpowers");
const DATA_COPY = join(HOME, "orbita/datos/miwebdeboda/seo-fase1");
const SEO_LABELS = ["seo-fase1", "seo-fase2", "seo-prueba"];
const WEB_REPO = "dieg092/wedding-invite-2";
const MAIN_CHECK = "Typecheck · Test · Build";
const MAIN_STATE = join(STATE_DIR, "main-ci.json");

/** Último commit de main de la web y la conclusión de su CI (con el gh del Mac). */
function mainCi(): MainCiSnap | null {
  try {
    const gh = (p: string, jq: string) => execFileSync("gh", ["api", p, "--jq", jq], { encoding: "utf8", timeout: 60_000 }).trim();
    const [sha, date] = gh(`repos/${WEB_REPO}/commits/main`, '[.sha, .commit.committer.date] | @tsv').split("\t");
    const conclusion = gh(`repos/${WEB_REPO}/commits/${sha}/check-runs?check_name=${encodeURIComponent(MAIN_CHECK)}`, "[.check_runs[0].conclusion // \"\"] | .[0]");
    return { sha, conclusion: conclusion || null, ageMinutes: (Date.now() - Date.parse(date)) / 60_000 };
  } catch {
    return null;
  }
}

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

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function restoreDocsCopy(): boolean {
  if (existsSync(join(DATA_COPY, "plan.md")) || !existsSync(DOCS)) return false;
  mkdirSync(join(DATA_COPY, "spec"), { recursive: true });
  cpSync(join(DOCS, "specs"), join(DATA_COPY, "spec"), { recursive: true });
  const plans = readdirSync(join(DOCS, "plans")).filter((f) => f.includes("fase1-datos-gsc-sonda")).sort();
  if (plans.length) cpSync(join(DOCS, "plans", plans[plans.length - 1]), join(DATA_COPY, "plan.md"));
  return true;
}

async function loadTasks(): Promise<TaskSnap[]> {
  const env = readEnvFile(ORBITA_ENV);
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: tasks, error } = await db.from("tasks").select("id,title,status,labels").overlaps("labels", SEO_LABELS);
  if (error) throw new Error(`Órbita: ${error.message}`);
  const ids = (tasks ?? []).map((t) => t.id as string);
  if (!ids.length) return [];
  const [{ data: comments }, { data: jobs }] = await Promise.all([
    db.from("task_comments").select("task_id,body,created_at").in("task_id", ids).like("body", "🤖%").order("created_at", { ascending: false }),
    db.from("copy_jobs").select("subject_id,status,error,created_at").in("subject_id", ids).order("created_at", { ascending: false }),
  ]);
  const lastNote = new Map<string, string>();
  for (const c of comments ?? []) if (!lastNote.has(c.task_id)) lastNote.set(c.task_id, c.body);
  const lastJob = new Map<string, string>();
  // un encargo «failed» solo por haber sido sustituido o por falta de cuota no es un fallo real
  for (const j of jobs ?? []) {
    if (lastJob.has(j.subject_id)) continue;
    const benign = j.status === "failed" && /Sustituido por un encargo|Sin uso de Claude/i.test(j.error ?? "");
    lastJob.set(j.subject_id, benign ? "superseded" : j.status);
  }
  return (tasks ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, labels: t.labels ?? [], lastNote: lastNote.get(t.id) ?? null, jobStatus: lastJob.get(t.id) ?? null }));
}

async function main() {
  if (!acquireLock()) {
    console.log("seo-tick: otra ejecución en curso, se omite");
    return;
  }
  try {
    if (restoreDocsCopy()) console.log("seo-tick: restaurada la copia de spec y plan en la carpeta de datos");
    const prev: TickState = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
    const curr = await loadTasks();
    const events = computeEvents(prev, curr);
    for (const e of events) {
      await recordAlert({ type: `seo-tick-${e.kind}`, subject: `SEO · ${e.title}`, body: `${e.detail}\nTarea ${e.taskId}` });
      console.log(`seo-tick: aviso ${e.kind} · ${e.title}`);
    }
    const ci = mainCi();
    if (ci) {
      const prevMain = existsSync(MAIN_STATE) ? (JSON.parse(readFileSync(MAIN_STATE, "utf8")) as { sha?: string }).sha ?? null : null;
      const ev = mainCiEvent(prevMain, ci);
      if (ev) {
        await recordAlert({ type: "seo-tick-main-ci", subject: `Web · ${ev.title}`, body: ev.detail });
        console.log(`seo-tick: aviso CI de main · ${ev.detail}`);
      }
      // solo se marca como visto un commit con CI terminada (o ya avisado), para volver a mirarlo si sigue en curso
      if (ev || ci.conclusion) writeFileSync(MAIN_STATE, JSON.stringify({ sha: ci.sha }));
    }
    const tmp = `${STATE}.tmp`;
    writeFileSync(tmp, JSON.stringify(nextState(curr)));
    renameSync(tmp, STATE);
    await prisma.workflowHeartbeat.upsert({
      where: { workflowName: "seo-tick" },
      create: { workflowName: "seo-tick", lastStatus: "success" },
      update: { lastRunAt: new Date(), lastStatus: "success" },
    });
    console.log(`seo-tick: ${curr.length} tareas SEO, ${events.length} avisos`);
  } finally {
    rmSync(LOCK, { force: true });
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error("seo-tick falló:", error);
  try {
    await prisma.workflowHeartbeat.upsert({
      where: { workflowName: "seo-tick" },
      create: { workflowName: "seo-tick", lastStatus: "failure" },
      update: { lastRunAt: new Date(), lastStatus: "failure" },
    });
  } catch {}
  process.exit(1);
});
