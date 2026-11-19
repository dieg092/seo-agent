// src/editorial/paired.ts
// Evaluación por parejas main/rama (plan de Codex, paso 2). La usan la guarda premerge y la
// batería de defectos, así que la batería prueba exactamente la decisión que se toma en un PR.
//   - cifras nuevas: bloqueo determinista antes de evaluar (claims.ts);
//   - dos evaluaciones independientes de cada versión; si se separan más de DISAGREEMENT, una
//     tercera y vale la mediana. Si no, la rama vale la más baja y main la más alta (conservador);
//   - suelo de CRITERION_FLOOR en todos los criterios de todas las evaluaciones de la rama;
//   - los criterios críticos (intención, precisión, afirmaciones) no pueden empeorar más de
//     CRITICAL_MAX_DROP frente a main;
//   - aprueba si la rama llega a APPROVE_MIN y mejora a main en MIN_IMPROVEMENT o más.
import { createHash } from "node:crypto";
import { extractArticleFromMarkdown } from "./article";
import { detectHollow } from "./hollow";
import { EVALUATOR_MODEL, SYSTEM_PROMPT, evaluateArticle, evaluationSchema, type Evaluation, type Runner } from "./evaluator";
import { CLAIMS_VERSION, unsourcedNewFigures } from "./claims";
import { admittingFact, type Fact } from "./evidence";
import { APPROVE_MIN, CRITERION_FLOOR, CRITERION_KEYS, RUBRIC_VERSION, type CriterionKey } from "./rubric";

export const GATE_VERSION = "gate-v3";
export const MIN_IMPROVEMENT = 0.5;
export const DISAGREEMENT = 1;
export const CRITICAL: CriterionKey[] = ["intencion", "precision", "afirmacionesSinJustificar"];
export const CRITICAL_MAX_DROP = 0.5;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Todo lo que cambia una decisión: si cambia, la batería y la caché dejan de valer. */
export function editorialConfigKey(): string {
  // también las reglas deterministas (fuente de claims.ts vía su versión) y el esquema de respuesta
  return hash([GATE_VERSION, CLAIMS_VERSION, hash(JSON.stringify(evaluationSchema)), RUBRIC_VERSION, hash(SYSTEM_PROMPT), EVALUATOR_MODEL, MIN_IMPROVEMENT, DISAGREEMENT, CRITICAL.join(","), CRITICAL_MAX_DROP].join("|")).slice(0, 16);
}

export interface VersionScore {
  score: number;
  evals: Evaluation[];
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 100) / 100;

/** Dos evaluaciones (tres si discrepan); `side` decide hacia dónde se redondea la duda. */
export async function scoreVersion(input: { url: string; md: string; siteBase: string; runner: Runner }, side: "base" | "head"): Promise<VersionScore> {
  const doc = extractArticleFromMarkdown(input.md, input.siteBase);
  const hollow = detectHollow(doc.text);
  const once = () => evaluateArticle({ url: input.url, doc, hollow, similar: [] }, input.runner);
  // en serie: una sola llamada al modelo a la vez (cupo compartido con Órbita)
  const evals = [await once(), await once()];
  if (Math.abs(evals[0].score - evals[1].score) > DISAGREEMENT) {
    evals.push(await once());
    return { score: round(median(evals.map((e) => e.score))), evals };
  }
  const pick = side === "head" ? Math.min : Math.max;
  return { score: round(pick(evals[0].score, evals[1].score)), evals };
}

const meanCriterion = (v: VersionScore, k: CriterionKey) => v.evals.reduce((s, e) => s + e.criteria[k].score, 0) / v.evals.length;

export interface PairedDecision {
  approve: boolean;
  reason: string;
  base: VersionScore | null;
  head: VersionScore | null;
  gain: number | null;
  evaluated: boolean;
}

/** Parte determinista de la decisión (sin llamadas): un motivo de bloqueo o null. */
export function deterministicBlock(baseMd: string, headMd: string, label: string, facts: readonly Fact[] = []): string | null {
  const unsourced = unsourcedNewFigures(baseMd, headMd, (p, f) => admittingFact(p, f, facts) !== null);
  if (unsourced.length === 0) return null;
  return `bloquea: ${label} añade cifras que no estaban en main ni en los datos admitidos, o sin citarlos como toca (${unsourced.slice(0, 3).map((u) => u.figure).join(", ")}) — qué falla: usa solo cifras de la lista de datos admitidos, en un párrafo sobre lo mismo y con su enlace o el nombre de su fuente`;
}

export async function pairedDecision(input: { url: string; label: string; baseMd: string; headMd: string; siteBase: string; runner: Runner; base?: VersionScore; facts?: readonly Fact[] }): Promise<PairedDecision> {
  const blocked = deterministicBlock(input.baseMd, input.headMd, input.label, input.facts ?? []);
  if (blocked) return { approve: false, reason: blocked, base: null, head: null, gain: null, evaluated: false };
  const common = { url: input.url, siteBase: input.siteBase, runner: input.runner };
  const base = input.base ?? (await scoreVersion({ ...common, md: input.baseMd }, "base"));
  const head = await scoreVersion({ ...common, md: input.headMd }, "head");
  const gain = round(head.score - base.score);
  const out = (approve: boolean, reason: string): PairedDecision => ({ approve, reason, base, head, gain, evaluated: true });

  // Motivo útil para la ronda de corrección: los criterios más flojos de la rama con la nota del evaluador.
  const why = (keys: CriterionKey[]) => {
    const worst = (keys.length ? keys : [...CRITERION_KEYS].sort((a, b) => meanCriterion(head, a) - meanCriterion(head, b))).slice(0, 3);
    const notes = worst
      .map((k) => {
        const e = [...head.evals].sort((x, y) => x.criteria[k].score - y.criteria[k].score)[0];
        const note = e.criteria[k].note.replace(/\s+/g, " ").trim().slice(0, 70);
        return note ? `${k}: ${note}` : null;
      })
      .filter(Boolean);
    return notes.length ? ` — qué falla: ${notes.join("; ")}` : "";
  };
  const low = CRITERION_KEYS.filter((k) => head.evals.some((e) => e.criteria[k].score < CRITERION_FLOOR));
  if (low.length) return out(false, `bloquea: ${input.label} en la rama tiene criterios por debajo de ${CRITERION_FLOOR}: ${low.join(", ")} (main ${base.score})${why(low)}`);
  const worse = CRITICAL.filter((k) => meanCriterion(base, k) - meanCriterion(head, k) > CRITICAL_MAX_DROP);
  if (worse.length) return out(false, `bloquea: ${input.label} empeora criterios críticos: ${worse.join(", ")}${why(worse)}`);
  if (head.score < APPROVE_MIN) return out(false, `bloquea: ${input.label} en la rama nota ${head.score} < ${APPROVE_MIN} (main ${base.score})${why([])}`);
  if (gain < MIN_IMPROVEMENT) return out(false, `bloquea: ${input.label} solo mejora ${gain} (${base.score} → ${head.score}; hace falta +${MIN_IMPROVEMENT})${why([])}`);
  return out(true, `aprueba: ${input.label} pasa de ${base.score} a ${head.score}`);
}
