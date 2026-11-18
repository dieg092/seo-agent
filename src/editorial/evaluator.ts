// src/editorial/evaluator.ts
// Capa de IA (§16.4): un evaluador distinto del redactor. Es una sesión de Claude sin
// herramientas (no puede leer ni escribir nada más que lo que se le da), con salida
// JSON forzada por esquema. Cada criterio cita su evidencia; lo que no se puede
// verificar en el texto se topa a 6 (rubric.applyCaps).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { CRITERIA, CRITERION_KEYS, RUBRIC_VERSION, applyCaps, weightedScore, type CriteriaScores } from "./rubric";
import type { ArticleDoc } from "./article";
import type { HollowResult } from "./hollow";

export type Runner = (a: { system: string; user: string; schema: object }) => Promise<unknown>;

export const evaluationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "summary"],
  properties: {
    summary: { type: "string" },
    criteria: {
      type: "object",
      additionalProperties: false,
      required: CRITERION_KEYS,
      properties: Object.fromEntries(
        CRITERION_KEYS.map((k) => [
          k,
          {
            type: "object",
            additionalProperties: false,
            required: ["score", "evidence", "note"],
            properties: { score: { type: "number", minimum: 0, maximum: 10 }, evidence: { type: "array", items: { type: "string" }, maxItems: 3 }, note: { type: "string" } },
          },
        ]),
      ),
    },
  },
} as const;

export const SYSTEM_PROMPT = `Eres un editor exigente que evalúa artículos del blog de miwebdeboda.com (webs de boda, invitaciones digitales, confirmación de asistencia y organización de bodas en España). No has escrito el artículo y no tienes que defenderlo.

Puntúa cada criterio de 0 a 10 con esta escala: 3 = malo, 5 = contenido web corriente, 7 = bueno y útil, 9 = excepcional, de lo mejor que hay en español sobre el tema. La mayoría de artículos corrientes están entre 5 y 7. No regales notas.

Los criterios de riesgo puntúan al revés: 10 = ningún riesgo.

Evidencia: por cada criterio, de 1 a 3 citas LITERALES del artículo (copiadas exactamente, al menos 12 caracteres) o hechos estructurales copiados tal cual de la lista que se te da. Se comprueban: una cita que no esté en el texto no cuenta y el criterio queda en 6 como mucho. La nota de cada criterio en una frase corta.

Responde solo con el JSON pedido.`;

export function buildUserPrompt(a: { url: string; doc: ArticleDoc; hollow: HollowResult; similar: string[] }): string {
  const criteria = CRITERIA.map((c) => `- ${c.key}: ${c.label}`).join("\n");
  const signals = a.hollow.signals.length ? a.hollow.signals.map((s) => `- ${s.check}: ${s.detail}`).join("\n") : "- ninguna";
  return [
    `Rúbrica ${RUBRIC_VERSION}. Criterios:\n${criteria}`,
    `URL: ${a.url}`,
    `Artículos parecidos del mismo blog (para el riesgo de canibalización): ${a.similar.length ? a.similar.join(", ") : "ninguno"}`,
    `Señales de fórmulas vacías del detector determinista:\n${signals}`,
    `Hechos estructurales:\n${a.doc.facts.map((f) => `- ${f}`).join("\n")}`,
    `ARTÍCULO:\n<<<\n${a.doc.text}\n>>>`,
  ].join("\n\n");
}

export interface Evaluation {
  score: number;
  criteria: CriteriaScores;
  summary: string;
}

/** Valida la respuesta sin fiarse de ella: todo criterio, número y lista de textos. */
export function parseEvaluation(raw: unknown): { criteria: CriteriaScores; summary: string } {
  const r = raw as { criteria?: Record<string, unknown>; summary?: unknown };
  if (!r || typeof r !== "object" || !r.criteria || typeof r.criteria !== "object") throw new Error("respuesta sin criterios");
  const criteria = {} as CriteriaScores;
  for (const k of CRITERION_KEYS) {
    const c = r.criteria[k] as { score?: unknown; evidence?: unknown; note?: unknown } | undefined;
    if (!c || typeof c.score !== "number" || !Number.isFinite(c.score)) throw new Error(`criterio ${k} sin nota`);
    const evidence = Array.isArray(c.evidence) ? c.evidence.filter((e): e is string => typeof e === "string").slice(0, 3) : [];
    criteria[k] = { score: c.score, evidence, note: typeof c.note === "string" ? c.note.slice(0, 300) : "" };
  }
  return { criteria, summary: typeof r.summary === "string" ? r.summary.slice(0, 1000) : "" };
}

export async function evaluateArticle(a: { url: string; doc: ArticleDoc; hollow: HollowResult; similar: string[] }, runner: Runner): Promise<Evaluation> {
  const raw = await runner({ system: SYSTEM_PROMPT, user: buildUserPrompt(a), schema: evaluationSchema });
  const parsed = parseEvaluation(raw);
  const criteria = applyCaps(parsed.criteria, a.doc.text, a.doc.facts, a.hollow.hollow);
  return { score: weightedScore(criteria), criteria, summary: parsed.summary };
}

export const EVALUATOR_MODEL = process.env.EDITORIAL_MODEL ?? "opus";

/** Claude Code del Mac, sin herramientas, sin MCP, sin hooks y en una carpeta vacía. */
export const claudeRunner: Runner = ({ system, user, schema }) =>
  new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), "seo-editorial-"));
    const args = [
      "-p",
      "--tools", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--settings", JSON.stringify({ disableAllHooks: true }),
      "--output-format", "json",
      "--max-turns", "3",
      "--model", EVALUATOR_MODEL,
      "--append-system-prompt", system,
      "--json-schema", JSON.stringify(schema),
    ];
    // El LaunchAgent del puente no lleva ~/npm/bin en el PATH.
    const npmBin = join(process.env.HOME ?? "", "npm", "bin", "claude");
    const bin = process.env.CLAUDE_BIN ?? (existsSync(npmBin) ? npmBin : "claude");
    // Sin las variables de la BD ni de las cuentas: el evaluador no las necesita.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER ?? userInfo().username, TMPDIR: process.env.TMPDIR, LANG: "es_ES.UTF-8" };
    const p = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill(), 10 * 60_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(timer);
      try {
        const d = JSON.parse(out) as { result?: string; structured_output?: unknown; is_error?: boolean };
        if (code !== 0 || d.is_error) return reject(new Error(`claude salió con ${code}: ${(d.result ?? err).slice(0, 300)}`));
        resolve(d.structured_output ?? JSON.parse(d.result ?? ""));
      } catch {
        reject(new Error(`claude: salida no válida (${code}): ${(err || out).slice(0, 300)}`));
      }
    });
    p.stdin.end(user);
  });
