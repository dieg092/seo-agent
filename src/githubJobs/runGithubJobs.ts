// src/githubJobs/runGithubJobs.ts
// Trabajos que escriben en wedding-invite-2 por la API de GitHub. Antes corrían
// en GitHub Actions con el PAT WEDDING_INVITE_2_PAT (revocado el 2026-11-18);
// ahora los lanza el puente en el Mac con el inicio de sesión de gh:
//   - apply:tier1 una vez al día, después de la recogida diaria de las 06:00 UTC;
//   - sync:applied-changes y measure:applied-changes una vez a la semana.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";

const DAY_MS = 24 * 60 * 60 * 1000;
export const TIER1_JOB = "tier1-apply-mac";
export const WEEKLY_JOB = "weekly-sync-mac";

export interface JobPlan {
  tier1: boolean;
  weekly: boolean;
}

/** Qué toca hoy, según el último latido de cada trabajo y la recogida diaria. */
export function planJobs(now: Date, last: { tier1?: Date | null; weekly?: Date | null; collection?: Date | null }): JobPlan {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Tier 1 se basa en lo que priorizó la recogida de hoy: sin ella, espera.
  const collectedToday = !!last.collection && last.collection.getTime() >= dayStart;
  const tier1 = collectedToday && (!last.tier1 || last.tier1.getTime() < last.collection!.getTime());
  const weekly = !last.weekly || now.getTime() - last.weekly.getTime() >= 7 * DAY_MS - 60 * 60 * 1000;
  return { tier1, weekly };
}

function runScript(script: string): void {
  const root = join(__dirname, "..", "..");
  execFileSync(join(root, "node_modules", ".bin", "tsx"), [join("scripts", script)], {
    cwd: root,
    stdio: "inherit",
    timeout: 20 * 60_000,
  });
}

async function beat(name: string, status: string, now: Date) {
  await prisma.workflowHeartbeat.upsert({
    where: { workflowName: name },
    create: { workflowName: name, lastStatus: status, lastRunAt: now },
    update: { lastStatus: status, lastRunAt: now },
  });
}

async function runJob(name: string, scripts: string[], now: Date): Promise<string> {
  const failed: string[] = [];
  for (const s of scripts) {
    try {
      runScript(s);
    } catch {
      failed.push(s);
    }
  }
  await beat(name, failed.length ? "failed" : "ok", now);
  if (failed.length) {
    await recordAlert({ type: `${name}-failed`, subject: `Trabajo SEO ${name} con fallos`, body: `Han fallado: ${failed.join(", ")}. Mira ~/Library/Logs del puente.` });
  }
  return `${name}: ${failed.length ? `fallos en ${failed.join(", ")}` : "ok"}`;
}

export async function runGithubJobs(deps: { now?: Date } = {}): Promise<string[]> {
  const now = deps.now ?? new Date();
  const rows = await prisma.workflowHeartbeat.findMany({ where: { workflowName: { in: [TIER1_JOB, WEEKLY_JOB, "daily-collection"] } } });
  const at = (n: string) => rows.find((r) => r.workflowName === n)?.lastRunAt ?? null;
  const plan = planJobs(now, { tier1: at(TIER1_JOB), weekly: at(WEEKLY_JOB), collection: at("daily-collection") });
  const notes: string[] = [];
  if (plan.tier1) notes.push(await runJob(TIER1_JOB, ["apply-tier1.ts"], now));
  if (plan.weekly) notes.push(await runJob(WEEKLY_JOB, ["sync-applied-changes.ts", "measure-applied-changes.ts"], now));
  return notes;
}
