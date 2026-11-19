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
import { EVALUATOR_MODEL, SYSTEM_PROMPT, evaluateArticle, type Evaluation, type Runner } from "./evaluator";
import { unsourcedNewFigures } from "./claims";
import { APPROVE_MIN, CRITERION_FLOOR, CRITERION_KEYS, RUBRIC_VERSION, type CriterionKey } from "./rubric";

export const GATE_VERSION = "gate-v3";
export const MIN_IMPROVEMENT = 0.5;
export const DISAGREEMENT = 1;
export const CRITICAL: CriterionKey[] = ["intencion", "precision", "afirmacionesSinJustificar"];
export const CRITICAL_MAX_DROP = 0.5;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Todo lo que cambia una decisión: si cambia, la batería y la caché dejan de valer. */
export function editorialConfigKey(): string {
  return hash([GATE_VERSION, RUBRIC_VERSION, hash(SYSTEM_PROMPT), EVALUATOR_MODEL, MIN_IMPROVEMENT, DISAGREEMENT, CRITICAL.join(","), CRITICAL_MAX_DROP].join("|")).slice(0, 16);
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
  const evals = await Promise.all([once(), once()]);
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

export async function pairedDecision(input: { url: string; label: string; baseMd: string; headMd: string; siteBase: string; runner: Runner; base?: VersionScore }): Promise<PairedDecision> {
  const unsourced = unsourcedNewFigures(input.baseMd, input.headMd);
  if (unsourced.length > 0) {
    const list = unsourced.slice(0, 3).map((u) => u.figure).join(", ");
    return { approve: false, reason: `bloquea: ${input.label} añade cifras que no estaban en main (${list})`, base: null, head: null, gain: null, evaluated: false };
  }
  const common = { url: input.url, siteBase: input.siteBase, runner: input.runner };
  const [base, head] = await Promise.all([input.base ? Promise.resolve(input.base) : scoreVersion({ ...common, md: input.baseMd }, "base"), scoreVersion({ ...common, md: input.headMd }, "head")]);
  const gain = round(head.score - base.score);
  const out = (approve: boolean, reason: string): PairedDecision => ({ approve, reason, base, head, gain, evaluated: true });

  const low = CRITERION_KEYS.filter((k) => head.evals.some((e) => e.criteria[k].score < CRITERION_FLOOR));
  if (low.length) return out(false, `bloquea: ${input.label} en la rama tiene criterios por debajo de ${CRITERION_FLOOR}: ${low.join(", ")} (main ${base.score})`);
  const worse = CRITICAL.filter((k) => meanCriterion(base, k) - meanCriterion(head, k) > CRITICAL_MAX_DROP);
  if (worse.length) return out(false, `bloquea: ${input.label} empeora criterios críticos: ${worse.join(", ")}`);
  if (head.score < APPROVE_MIN) return out(false, `bloquea: ${input.label} en la rama nota ${head.score} < ${APPROVE_MIN} (main ${base.score})`);
  if (gain < MIN_IMPROVEMENT) return out(false, `bloquea: ${input.label} solo mejora ${gain} (${base.score} → ${head.score}; hace falta +${MIN_IMPROVEMENT})`);
  return out(true, `aprueba: ${input.label} pasa de ${base.score} a ${head.score}`);
}
