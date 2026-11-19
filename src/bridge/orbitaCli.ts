// src/bridge/orbitaCli.ts
// Llamadas al CLI de Órbita (scripts/orbita-task.ts), que usa su propia
// credencial (.env.worker). El puente no toca la base de Órbita directamente.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const ORBITA = join(homedir(), "Projects/personal/orbita");
export const ORBITA_ACTIVITY = "miwebdeboda.com";

export interface OrbitaTask {
  id: string;
  status: string;
  labels: string[];
  blocked_reason: string | null;
}

export interface OrbitaClient {
  get(id: string): Promise<OrbitaTask | null>;
  add(input: {
    title: string;
    description: string;
    priority: string;
    labels: string[];
    metadataFile: string;
    dedupeKey: string;
    aiPrompt: string | null;
    /** Tarea SEO automática (A1): entra con seo-auto en vez de «propuesta». */
    auto?: boolean;
  }): Promise<{ id: string; created: boolean }>;
  comment(id: string, text: string): Promise<void>;
  cancelIfTodo(id: string, reason: string): Promise<boolean>;
  /** Cancela una tarea empezada (p. ej., con el PR retenido demasiado tiempo); solo si sigue en curso. */
  cancelIfInProgress(id: string, reason: string): Promise<boolean>;
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      join(ORBITA, "node_modules/.bin/tsx"),
      [join(ORBITA, "scripts/orbita-task.ts"), ...args],
      { cwd: ORBITA, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout.trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  if (!line) throw new Error(`Órbita no devolvió JSON: ${stdout.slice(0, 300)}`);
  return JSON.parse(line);
}

export const orbitaCli: OrbitaClient = {
  async get(id) {
    const r = await run(["get", id, "--json"]);
    if (r.code !== 0) {
      if (/No hay ninguna tarea/.test(r.stderr + r.stdout)) return null;
      throw new Error(`orbita get ${id}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    }
    return lastJsonLine(r.stdout) as OrbitaTask;
  },
  async add(input) {
    const args = [
      "add",
      "--actividad", ORBITA_ACTIVITY,
      "--titulo", input.title,
      "--descripcion", input.description,
      "--prioridad", input.priority,
      "--labels", input.labels.join(","),
      "--metadata-file", input.metadataFile,
      "--dedupe-key", input.dedupeKey,
      "--json",
      ...(input.aiPrompt ? ["--ia", "--prompt", input.aiPrompt] : []),
      ...(input.auto ? ["--auto"] : []),
    ];
    const r = await run(args);
    if (r.code !== 0) throw new Error(`orbita add: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return lastJsonLine(r.stdout) as { id: string; created: boolean };
  },
  async comment(id, text) {
    const r = await run(["comment", id, "--texto", text]);
    if (r.code !== 0) throw new Error(`orbita comment ${id}: ${(r.stderr || r.stdout).slice(0, 300)}`);
  },
  async cancelIfTodo(id, reason) {
    const r = await run(["cancel", id, "--if-status", "todo", "--motivo", reason, "--json"]);
    if (r.code !== 0) throw new Error(`orbita cancel ${id}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return (lastJsonLine(r.stdout) as { cancelled: boolean }).cancelled;
  },
  async cancelIfInProgress(id, reason) {
    const r = await run(["cancel", id, "--if-status", "in_progress", "--motivo", reason, "--json"]);
    if (r.code !== 0) throw new Error(`orbita cancel ${id}: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return (lastJsonLine(r.stdout) as { cancelled: boolean }).cancelled;
  },
};
