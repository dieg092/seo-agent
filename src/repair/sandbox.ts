// src/repair/sandbox.ts
// Ejecuta el agente reparador (Claude Code) aislado con las MISMAS capas que los agentes de
// Órbita (~/Projects/personal/orbita/src/domain/agent-sandbox.ts): entorno limpio, modo
// --restricted, sandbox del sistema para Bash (sin leer credenciales ni .env, red solo a
// registros de paquetes) y reglas de lectura denegada. Se importa en tiempo de ejecución para
// no duplicar las reglas; si no está, el reparador no se ejecuta.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const ORBITA_SANDBOX = join(homedir(), "Projects/personal/orbita/src/domain/agent-sandbox.ts");

/** Herramientas del reparador: editar y verificar; nada de git que escriba ni de red. */
export const REPAIR_ALLOWED = [
  "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(npx tsc *)", "Bash(npx tsx --test *)",
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
  "Bash(ls*)", "Bash(cat *)", "Bash(grep *)", "Bash(find *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
];
/** Reparador de la web (wi2): tipos, lint y tests unitarios sin BD; nada más. */
export const WEB_REPAIR_ALLOWED = [
  "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite",
  "Bash(npx tsc *)", "Bash(npx eslint *)", "Bash(npx tsx --test *)",
  "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)",
  "Bash(ls*)", "Bash(cat *)", "Bash(grep *)", "Bash(find *)", "Bash(head *)", "Bash(tail *)", "Bash(wc *)",
];
export const REPAIR_DISALLOWED = [
  "Bash(git push*)", "Bash(git commit*)", "Bash(git add*)", "Bash(git reset*)", "Bash(git checkout*)", "Bash(git clean*)",
  "Bash(git remote*)", "Bash(git worktree*)", "Bash(git fetch*)", "Bash(git config*)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)",
  "Bash(rm -rf*)", "Bash(npx prisma*)", "Bash(pnpm *)", "Bash(npm *)", "Bash(node *)", "Bash(npx tsx scripts*)",
  "Bash(npx playwright*)", "Bash(npx next*)", "Bash(vercel*)", "Bash(npx vercel*)",
  "mcp__*", "WebFetch", "WebSearch", "NotebookEdit",
];

/** Todos los .env* bajo ~/Projects (sin node_modules ni .git): ninguno es legible para el agente. */
export function findEnvFiles(root: string, depth = 6, out: string[] = []): string[] {
  if (depth < 0 || !existsSync(root)) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === ".next" || e === "dist") continue;
    const p = join(root, e);
    if (e.startsWith(".env")) out.push(p);
    else {
      try {
        if (statSync(p).isDirectory()) findEnvFiles(p, depth - 1, out);
      } catch {
        // enlace roto o sin permiso
      }
    }
  }
  return out;
}

export function claudeBin(): string {
  const npmBin = join(homedir(), "npm", "bin", "claude");
  return process.env.CLAUDE_BIN ?? (existsSync(npmBin) ? npmBin : "claude");
}

export interface AgentRun {
  ok: boolean;
  text: string;
  denials: string[];
  error?: string;
}

export async function runSandboxedAgent(cwd: string, prompt: string, timeoutMs = 20 * 60_000, allowed: string[] = REPAIR_ALLOWED): Promise<AgentRun> {
  if (!existsSync(ORBITA_SANDBOX)) return { ok: false, text: "", denials: [], error: "no está el módulo de aislamiento de Órbita" };
  const sb = await import(ORBITA_SANDBOX as string);
  const tmpDir = mkdtempSync("/tmp/seo-repair-agent-"); // como Órbita: el TMPDIR del agente cuelga de aquí
  try {
    const home = homedir();
    const input = { home, envFiles: findEnvFiles(join(home, "Projects")), gitDirs: [] as string[], writeDirs: [cwd], tmpDir };
    const settings = { disableAllHooks: true, ...sb.buildSandboxSettings(input) };
    const args = [
      "-p", "--restricted", "--tools", ...sb.AGENT_TOOLS, "--no-session-persistence", "--strict-mcp-config",
      "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
      "--settings", JSON.stringify(settings), "--max-turns", "60",
      "--allowedTools", ...allowed, "--disallowedTools", ...REPAIR_DISALLOWED, ...sb.denyReadRules(input),
    ];
    const env = sb.agentEnv(process.env, { GIT_TERMINAL_PROMPT: "0", CLAUDE_CODE_TMPDIR: tmpDir, TMPDIR: tmpDir, SEO_ENV: "test" });
    const r = spawnSync(claudeBin(), args, { cwd, input: prompt, encoding: "utf8", timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024 });
    const msgs = (r.stdout ?? "")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    const result = msgs.find((m) => m.type === "result");
    const denials = ((result?.permission_denials ?? []) as { tool_name: string; tool_input: Record<string, unknown> }[]).map(
      (d) => `${d.tool_name}(${String(d.tool_input.file_path ?? d.tool_input.command ?? "").slice(0, 120)})`
    );
    if (!result) return { ok: false, text: "", denials, error: `claude sin resultado (código ${r.status ?? r.signal})` };
    if (result.is_error) return { ok: false, text: String(result.result ?? ""), denials, error: `claude devolvió error: ${String(result.result ?? result.subtype).slice(0, 300)}` };
    return { ok: true, text: String(result.result ?? ""), denials };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
