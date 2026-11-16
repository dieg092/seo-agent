// scripts/seo-guard-check.ts
// Guarda de Órbita para las tareas SEO automáticas (anexo C.3, O4). La lanza el
// worker de Órbita (COPY_WORKER_GUARD_CMD), nunca la IA:
//   tsx scripts/seo-guard-check.ts preflight <taskId>
//   tsx scripts/seo-guard-check.ts scope <taskId> <carpeta del worktree>
//   tsx scripts/seo-guard-check.ts premerge <taskId> <url del PR>
// Sale con 0 (adelante), 75 (retener y reintentar más tarde) o 1 (bloquear), y
// escribe el motivo en una línea. Si no puede leer Neon, retiene.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { prisma } from "../src/db";
import { readControl } from "../src/brake/control";
import { recordAlert } from "../src/alerts/recordAlert";
import { BLOCK, HOLD, guardDecision, type GuardStage, type PullRequestInfo } from "../src/bridge/guard";
import { parseNumstat, type DiffFile } from "../src/bridge/scopeCheck";

const SELF = join(__dirname, "..");
const run = (cmd: string, args: string[], cwd?: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();

/** Diff de la rama de la tarea contra origin/main (desde donde salió). */
function branchDiff(dir: string): DiffFile[] {
  run("git", ["-C", dir, "fetch", "-q", "origin", "main"]);
  return parseNumstat(run("git", ["-C", dir, "diff", "--numstat", "--no-renames", "origin/main...HEAD"]));
}

/** El código de seo-agent que decide es el de origin/main, sin cambios locales. */
function selfIntact(): boolean {
  try {
    run("git", ["-C", SELF, "fetch", "-q", "origin", "main"]);
    const dirty = run("git", ["-C", SELF, "status", "--porcelain", "--untracked-files=no"]);
    return dirty === "" && run("git", ["-C", SELF, "rev-parse", "HEAD"]) === run("git", ["-C", SELF, "rev-parse", "origin/main"]);
  } catch {
    return false;
  }
}

/** El PR por la API de GitHub: título, etiquetas y ficheros (un renombrado cuenta como «origen => destino»). */
function readPullRequest(url: string): PullRequestInfo | undefined {
  try {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
    if (!m) return undefined;
    const [, repo, num] = m;
    const pr = JSON.parse(run("gh", ["pr", "view", url, "--json", "title,labels,state,baseRefName"])) as {
      title: string;
      labels: { name: string }[];
      state: string;
      baseRefName: string;
    };
    const files = JSON.parse(
      run("gh", ["api", "--paginate", "--slurp", `repos/${repo}/pulls/${num}/files?per_page=100`]),
    ) as { filename: string; previous_filename?: string; additions: number; deletions: number; status: string }[][];
    return {
      title: pr.title,
      labels: pr.labels.map((l) => l.name),
      state: pr.state,
      baseRefName: pr.baseRefName,
      files: files.flat().map((f) => ({
        path: f.previous_filename && f.status === "renamed" ? `${f.previous_filename} => ${f.filename}` : f.filename,
        added: f.additions,
        deleted: f.deletions,
      })),
    };
  } catch {
    return undefined;
  }
}

async function main(): Promise<number> {
  const [stage, taskId, target] = process.argv.slice(2) as [GuardStage, string, string | undefined];
  if (!["preflight", "scope", "premerge"].includes(stage) || !taskId || (stage !== "preflight" && !target)) {
    console.log("uso: seo-guard-check.ts preflight <taskId> | scope <taskId> <dir> | premerge <taskId> <prUrl>");
    return BLOCK;
  }
  let link;
  try {
    link = await prisma.seoTaskLink.findUnique({ where: { orbitaTaskId: taskId } });
  } catch {
    console.log("no se puede leer seo-agent (Neon): se reintenta más tarde");
    return HOLD;
  }
  const control = await readControl();
  let diff: DiffFile[] | undefined;
  if (stage === "scope") {
    try {
      diff = branchDiff(target!);
    } catch (e) {
      console.log(`no se pudo calcular el diff de la rama: ${(e as Error).message.slice(0, 200)}`);
      return BLOCK;
    }
  }
  const d = guardDecision({
    stage,
    control,
    link,
    diff,
    pr: stage === "premerge" ? readPullRequest(target!) : undefined,
    selfIntact: stage === "premerge" ? selfIntact() : undefined,
  });
  console.log(d.reason);
  if (d.code === BLOCK && link) {
    try {
      await recordAlert({
        type: "seo-guard-blocked",
        subject: `Guarda SEO: tarea bloqueada (${stage})`,
        body: `Tarea ${taskId.slice(0, 8)} (${link.operation ?? "sin operación"}): ${d.reason}`,
      });
    } catch {
      // el motivo ya queda en la tarea de Órbita
    }
  }
  return d.code;
}

main()
  .catch((e) => {
    console.log(`error de la guarda: ${(e as Error).message.slice(0, 200)}`);
    return HOLD;
  })
  .then(async (code) => {
    await prisma.$disconnect().catch(() => {});
    process.exit(code);
  });
