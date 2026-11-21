// src/repair/web/github.ts
// Todo lo que el reparador web hace en GitHub, con el gh autenticado del Mac. Solo metadatos de
// Actions y líneas de error saneadas; nunca se descargan artefactos ni se guardan logs enteros.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../git";
import { APP_REPO, type WebSource } from "./classify";
import { errorLines, sanitizeLine } from "./privacy";

export interface Run {
  id: number;
  attempt: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  headSha: string;
  event: string;
  url: string;
}

function gh(args: string[], cwd = tmpdir(), timeoutMs = 120_000): string {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, env: childEnv(), maxBuffer: 64 * 1024 * 1024 });
}

function git(args: string[], cwd: string, timeoutMs = 180_000): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, env: childEnv(), maxBuffer: 32 * 1024 * 1024 });
}

const RUN_FIELDS = "databaseId,attempt,status,conclusion,createdAt,headSha,event,url";

function toRun(r: Record<string, unknown>): Run {
  return {
    id: Number(r.databaseId),
    attempt: Number(r.attempt ?? 1),
    status: String(r.status),
    conclusion: (r.conclusion as string) || null,
    createdAt: String(r.createdAt),
    headSha: String(r.headSha),
    event: String(r.event),
    url: String(r.url),
  };
}

/** Últimas ejecuciones TERMINADAS de una fuente, de la más nueva a la más antigua. */
export function listRuns(s: WebSource, limit = 10): Run[] {
  const args = ["run", "list", "-R", s.repo, "-w", s.workflow, "-L", String(limit), "--json", RUN_FIELDS];
  if (s.branch) args.push("-b", s.branch);
  const rows = JSON.parse(gh(args)) as Record<string, unknown>[];
  return rows
    .map(toRun)
    .filter((r) => r.status === "completed" && r.event !== "pull_request")
    .filter((r) => s.component !== "web-ci" || r.event === "push" || r.event === "schedule" || r.event === "workflow_dispatch");
}

/** Pasos fallidos («job :: paso») y líneas de error saneadas de una ejecución. */
export function runFailure(s: WebSource, run: Run): { failedSteps: string[]; lines: string[] } {
  let failedSteps: string[] = [];
  const failedJobIds: number[] = [];
  try {
    const jobs = JSON.parse(gh(["api", `repos/${s.repo}/actions/runs/${run.id}/jobs`, "--jq", ".jobs"])) as {
      id: number;
      name: string;
      conclusion: string;
      steps?: { name: string; conclusion: string }[];
    }[];
    for (const j of jobs) {
      if (j.conclusion !== "failure" && j.conclusion !== "timed_out") continue;
      const steps = (j.steps ?? []).filter((st) => st.conclusion === "failure").map((st) => `${j.name} :: ${st.name}`);
      failedSteps.push(...(steps.length ? steps : [`${j.name} :: (sin paso)`]));
      failedJobIds.push(j.id);
    }
  } catch {
    failedSteps = [];
  }
  const lines: string[] = [];
  // Anotaciones de los jobs fallidos: ahí sale por qué no arrancó un job (runner, facturación…).
  for (const id of failedJobIds.slice(0, 4)) {
    try {
      const msgs = JSON.parse(gh(["api", `repos/${s.repo}/check-runs/${id}/annotations`, "--jq", "[.[].message]"])) as string[];
      lines.push(...msgs.map((m) => sanitizeLine(m.split("\n")[0])));
    } catch {
      // sin anotaciones
    }
  }
  try {
    const log = gh(["run", "view", String(run.id), "-R", s.repo, "--log-failed"], tmpdir(), 180_000);
    lines.push(...errorLines(log));
    // la cola del log: el motivo final suele estar en las últimas líneas aunque no parezca un error
    lines.push(...log.split("\n").filter((l) => l.trim()).slice(-8).map((l) => sanitizeLine(l).trim()));
  } catch {
    // sin log
  }
  return { failedSteps: [...new Set(failedSteps)].slice(0, 12), lines: [...new Set(lines.filter(Boolean))].slice(0, 80) };
}

/** Relanza: mismos jobs fallidos (rerun) o una ejecución nueva del workflow (dispatch). */
export function retryRun(s: WebSource, run: Run): boolean {
  try {
    if (s.retry === "rerun") gh(["run", "rerun", String(run.id), "-R", s.repo, "--failed"]);
    else if (s.retry === "dispatch") gh(["workflow", "run", s.workflow, "-R", s.repo, "--ref", s.branch ?? "main"]);
    else return false;
    return true;
  } catch {
    return false;
  }
}

export function appMainSha(): string {
  return gh(["api", `repos/${APP_REPO}/commits/main`, "--jq", ".sha"]).trim();
}

/** Commit + push de la rama de reparación y PR contra main. */
export function pushPr(dir: string, branch: string, message: string, body: string): { number: number; url: string; head: string } {
  git(["checkout", "--quiet", "-b", branch], dir);
  git(["add", "--all"], dir);
  git(["commit", "--quiet", "-m", message], dir);
  git(["push", "--quiet", "-u", "origin", branch], dir);
  const head = git(["rev-parse", "HEAD"], dir).trim();
  const url = gh(["pr", "create", "-R", APP_REPO, "--head", branch, "--base", "main", "--title", message, "--body", body], dir).trim().split("\n").pop()!;
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!number) throw new Error("no se pudo crear el PR");
  return { number, url, head };
}

export interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: string;
  branch: string;
  behind: number;
  mergeSha: string | null;
}

export function prState(n: number): PrState {
  const v = JSON.parse(gh(["pr", "view", String(n), "-R", APP_REPO, "--json", "state,headRefOid,headRefName,mergeCommit"]));
  let behind = 0;
  if (v.state === "OPEN") {
    try {
      behind = Number(gh(["api", `repos/${APP_REPO}/compare/main...${v.headRefOid}`, "--jq", ".behind_by"]).trim());
    } catch {
      behind = 0;
    }
  }
  return { state: v.state, head: v.headRefOid, branch: v.headRefName, behind, mergeSha: v.mergeCommit?.oid ?? null };
}

export function updateBranch(n: number): void {
  gh(["api", "-X", "PUT", `repos/${APP_REPO}/pulls/${n}/update-branch`]);
}

/** CI completa (unit, integración, lint y E2E) sobre la rama: un push a ia/** no ejecuta E2E. */
export function dispatchCi(branch: string): void {
  gh(["workflow", "run", "ci.yml", "-R", APP_REPO, "--ref", branch, "-f", "full=true"]);
}

/** La ejecución de CI lanzada a mano sobre ese commit exacto de la rama (o null si aún no hay). */
export function branchCiRun(branch: string, head: string): Run | null {
  const rows = JSON.parse(gh(["run", "list", "-R", APP_REPO, "-w", "ci.yml", "-b", branch, "-e", "workflow_dispatch", "-L", "10", "--json", RUN_FIELDS])) as Record<string, unknown>[];
  return rows.map(toRun).find((r) => r.headSha === head) ?? null;
}

export function mergePr(n: number, head: string, subject: string): string {
  gh(["pr", "merge", String(n), "-R", APP_REPO, "--squash", "--match-head-commit", head, "--subject", subject, "--body", "", "--delete-branch"], tmpdir(), 180_000);
  const sha = gh(["pr", "view", String(n), "-R", APP_REPO, "--json", "mergeCommit", "-q", ".mergeCommit.oid"]).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("el PR no consta como fusionado");
  return sha;
}

export function closePr(n: number): void {
  try {
    gh(["pr", "close", String(n), "-R", APP_REPO, "--delete-branch"]);
  } catch {
    // ya estaba cerrado
  }
}

/** Copia aislada de wi2 en origin/main con `git revert` del commit aplicado (sin commit). */
export function revertInto(dir: string, sha: string): void {
  git(["revert", "--no-edit", "--no-commit", sha], dir);
}

/** Puerta local de la web: la misma que usa Órbita (tipos, lint, tests, guarda SEO, lint del blog). Sin BD. */
export function webGate(dir: string): { ok: boolean; detail: string } {
  const env = childEnv({ CI: "1", TMPDIR: mkdtempSync(join(tmpdir(), "web-gate-")) });
  try {
    const out = execFileSync("pnpm", ["-s", "orbita:gate"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900_000, env, maxBuffer: 64 * 1024 * 1024 });
    const pass = [...out.matchAll(/ℹ pass (\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
    return { ok: true, detail: `tipos, lint, ${pass} tests, guarda SEO y blog ok` };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    return { ok: false, detail: errorLines(text, 25).join("\n") || String(err.message ?? e).slice(0, 300) };
  }
}
