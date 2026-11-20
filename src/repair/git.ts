// src/repair/git.ts
// Git y GitHub del supervisor de reparación: copia aislada (worktree) desde origin/main, diff,
// puerta local (tsc + tests contra la BD local de tests), PR, fusión y reversión. El agente no
// ejecuta nada de esto: lo hace el supervisor fuera del sandbox.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiff, type DiffFile } from "./guard";

export const REPO_SLUG = "dieg092/seo-agent";

/** Entorno mínimo para los procesos hijos: nunca las URLs de producción que cargó el supervisor. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TERM|TZ|TMPDIR|PNPM_HOME|GH_CONFIG_DIR)$/;
  const out: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null", GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false" };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) out[k] = v;
  return { ...out, ...extra } as NodeJS.ProcessEnv;
}

function run(cmd: string, args: string[], cwd: string, opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: opts.timeoutMs ?? 120_000, env: opts.env ?? childEnv(), maxBuffer: 32 * 1024 * 1024 });
}

export interface Workspace {
  dir: string;
  baseSha: string;
  dispose: () => void;
}

/** Worktree limpio en origin/main, con node_modules del checkout principal enlazado (solo lectura de uso). */
export function createWorkspace(mainDir: string): Workspace {
  run("git", ["fetch", "--quiet", "origin", "main"], mainDir);
  const baseSha = run("git", ["rev-parse", "origin/main"], mainDir).trim();
  const dir = join(mkdtempSync(join(tmpdir(), "seo-repair-")), "wt");
  run("git", ["worktree", "add", "--detach", "--quiet", dir, baseSha], mainDir);
  symlinkSync(join(mainDir, "node_modules"), join(dir, "node_modules"));
  return {
    dir,
    baseSha,
    dispose: () => {
      try {
        run("git", ["worktree", "remove", "--force", dir], mainDir);
      } catch {
        rmSync(dir, { recursive: true, force: true });
        try {
          run("git", ["worktree", "prune"], mainDir);
        } catch {
          // nada más que hacer
        }
      }
    },
  };
}

/** Cambios de la copia respecto a su base, incluidos ficheros nuevos sin seguimiento. */
export function workspaceDiff(dir: string): DiffFile[] {
  run("git", ["add", "--intent-to-add", "--all", "--", ".", ":(exclude)node_modules"], dir);
  const numstat = run("git", ["diff", "--numstat", "HEAD"], dir);
  const nameStatus = run("git", ["diff", "--name-status", "HEAD"], dir);
  const patch = run("git", ["diff", "-U0", "HEAD"], dir);
  return parseDiff(numstat, nameStatus, patch);
}

/** Puerta local: typecheck y la suite completa contra la BD local de tests (SEO_ENV=test). */
export function localGate(dir: string): { ok: boolean; detail: string } {
  const env = childEnv({ SEO_ENV: "test", CI: "1" });
  try {
    run("npx", ["tsc", "--noEmit", "-p", "."], dir, { timeoutMs: 300_000, env });
  } catch (e) {
    return { ok: false, detail: `typecheck: ${tail(e)}` };
  }
  try {
    const out = run("pnpm", ["-s", "test"], dir, { timeoutMs: 900_000, env });
    const pass = /ℹ pass (\d+)/.exec(out)?.[1];
    const fail = /ℹ fail (\d+)/.exec(out)?.[1];
    if (fail && fail !== "0") return { ok: false, detail: `tests: ${fail} fallan` };
    return { ok: true, detail: `typecheck ok, ${pass ?? "?"} tests ok` };
  } catch (e) {
    return { ok: false, detail: `tests: ${tail(e)}` };
  }
}

function tail(e: unknown): string {
  const err = e as { stdout?: string; stderr?: string; message?: string };
  const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim() || String(err.message ?? e);
  const fails = text.split("\n").filter((l) => /^not ok|error TS|✖|fail/i.test(l)).slice(0, 8).join(" | ");
  return (fails || text.slice(-400)).slice(0, 600);
}

/** Commit, push, PR y fusión squash. Devuelve la URL del PR y el SHA fusionado en main. */
export function publish(dir: string, branch: string, message: string, body: string): { prUrl: string; mergedSha: string } {
  run("git", ["checkout", "--quiet", "-b", branch], dir);
  run("git", ["add", "--all", "--", ".", ":(exclude)node_modules"], dir);
  run("git", ["commit", "--quiet", "-m", message], dir);
  run("git", ["push", "--quiet", "-u", "origin", branch], dir, { timeoutMs: 180_000 });
  const prUrl = run("gh", ["pr", "create", "-R", REPO_SLUG, "--head", branch, "--base", "main", "--title", message, "--body", body], dir).trim().split("\n").pop()!;
  run("gh", ["pr", "merge", prUrl, "-R", REPO_SLUG, "--squash", "--delete-branch"], dir, { timeoutMs: 180_000 });
  const mergedSha = run("gh", ["pr", "view", prUrl, "-R", REPO_SLUG, "--json", "mergeCommit", "-q", ".mergeCommit.oid"], dir).trim();
  if (!/^[0-9a-f]{40}$/.test(mergedSha)) throw new Error("el PR no consta como fusionado");
  return { prUrl, mergedSha };
}

/** PR que revierte exactamente un commit de reparación. */
export function revertCommit(mainDir: string, sha: string, branch: string, message: string): { prUrl: string; mergedSha: string } {
  const ws = createWorkspace(mainDir);
  try {
    run("git", ["revert", "--no-edit", "--no-commit", sha], ws.dir);
    const gate = localGate(ws.dir);
    if (!gate.ok) throw new Error(`la reversión no pasa la puerta local: ${gate.detail}`);
    return publish(ws.dir, branch, message, `Revierte ${sha.slice(0, 8)}: tras la reparación automática apareció un fallo nuevo en el mismo componente.`);
  } finally {
    ws.dispose();
  }
}

/** Lleva el checkout del Mac (de donde corren los LaunchAgents) al main fusionado, solo si está limpio. */
export function updateMainCheckout(mainDir: string): { ok: boolean; reason?: string } {
  try {
    run("git", ["fetch", "--quiet", "origin", "main"], mainDir);
    const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], mainDir).trim();
    if (branch !== "main") return { ok: false, reason: `el checkout está en la rama ${branch}` };
    const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], mainDir).trim();
    if (dirty) return { ok: false, reason: "el checkout tiene cambios sin guardar" };
    run("git", ["merge", "--ff-only", "--quiet", "origin/main"], mainDir);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: tail(e) };
  }
}

export function headSha(mainDir: string): string {
  return run("git", ["rev-parse", "HEAD"], mainDir).trim();
}

export function ghFailedLog(runUrl: string): string | null {
  const id = /actions\/runs\/(\d+)/.exec(runUrl)?.[1];
  if (!id) return null;
  try {
    return run("gh", ["run", "view", id, "-R", REPO_SLUG, "--log-failed"], tmpdir(), { timeoutMs: 120_000 });
  } catch {
    return null;
  }
}

export function fileTail(path: string, lines = 80): string | null {
  if (!existsSync(path)) return null;
  try {
    return run("tail", ["-n", String(lines), path], tmpdir());
  } catch {
    return null;
  }
}
