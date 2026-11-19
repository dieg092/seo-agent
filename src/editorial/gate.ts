// src/editorial/gate.ts
// La IA editorial aprueba o bloquea sola las mejoras de artículos (B5: sin el fundador).
// Va en la guarda premerge de la operación content-improve, después de las
// comprobaciones generales (alcance, etiquetas, freno):
//   - con la calibración en verde (si no, se retiene);
//   - el PR cambia exactamente el fichero de contenido del artículo del contrato;
//   - se evalúan main y la rama con las mismas dos capas; se fusiona si la rama
//     aprueba (≥ 7, ningún criterio < 4, una nota ≥ 9 confirmada) y mejora a main en
//     al menos MIN_IMPROVEMENT. El mismo texto da siempre la misma respuesta (caché).
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { ALLOW, BLOCK, HOLD, type GuardDecision } from "../bridge/guard";
import { contentFromSource, extractArticleFromMarkdown } from "./article";
import { detectHollow } from "./hollow";
import { EVALUATOR_MODEL, SYSTEM_PROMPT, evaluateArticle, type Runner } from "./evaluator";
import { MIN_VALIDITY_N } from "./calibration";
import { unsourcedNewFigures } from "./claims";
import { EXCELLENT, RUBRIC_VERSION, combineExcellent, decide } from "./rubric";

export const MIN_IMPROVEMENT = 0.5;
/** Dos evaluaciones de la misma versión que se separan más de esto: se desempata con una tercera. */
export const DISAGREEMENT = 1;
/** Una calibración vale 35 días (se rehace cada 30). */
export const CALIBRATION_MAX_AGE_DAYS = 35;
/** La validez (nota–GSC) se recalcula en cada pasada del puente: más de 2 días sin ella, se retiene. */
export const VALIDITY_MAX_AGE_DAYS = 2;
/** Para fusionar sola, la nota no puede ir en contra de los datos de Google (ρ ≥ 0 con ≥ 12 artículos). */
export const MIN_GATE_RHO = 0;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTENT_FILE = /^src\/lib\/blog\/content\/([a-z0-9-]+)\/([a-z0-9-]+)\.ts$/;

export interface GateInput {
  files: string[];
  contractUrls: string[];
  baseRef: string;
  headRef: string;
  siteBase: string;
  /** Contenido de un fichero del repositorio en una referencia; null si no existe. */
  readFile: (path: string, ref: string) => Promise<string | null>;
  runner: Runner;
  now: Date;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Clave de la caché de la guarda: textos de main y de la rama, rúbrica, prompt y modelo. */
export function gateCacheKey(baseText: string, headText: string): string {
  return hash(["gate-v2", hash(baseText), hash(headText), RUBRIC_VERSION, hash(SYSTEM_PROMPT), EVALUATOR_MODEL].join("|"));
}

export async function editorialGate(g: GateInput): Promise<GuardDecision> {
  const calibration = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  if (calibration?.status !== "ok") return { code: HOLD, reason: `IA editorial suspendida (calibración ${calibration?.status ?? "pendiente"})` };
  if (g.now.getTime() - calibration.createdAt.getTime() > CALIBRATION_MAX_AGE_DAYS * DAY_MS) return { code: HOLD, reason: "IA editorial: la calibración ha caducado" };
  if (!calibration.validityAt || g.now.getTime() - calibration.validityAt.getTime() > VALIDITY_MAX_AGE_DAYS * DAY_MS)
    return { code: HOLD, reason: "IA editorial: sin validez reciente (nota frente a datos de Google)" };
  if ((calibration.validityN ?? 0) < MIN_VALIDITY_N) return { code: HOLD, reason: `IA editorial: validez pendiente (${calibration.validityN ?? 0} de ${MIN_VALIDITY_N} artículos con datos)` };
  if ((calibration.validityRho ?? -1) < MIN_GATE_RHO) return { code: HOLD, reason: `IA editorial: la nota no acompaña a los datos de Google (ρ ${calibration.validityRho})` };

  const content = g.files.filter((f) => CONTENT_FILE.test(f));
  if (content.length !== 1) return { code: BLOCK, reason: `el PR tiene que cambiar el contenido de un solo artículo (cambia ${content.length})` };
  const [, cat, name] = CONTENT_FILE.exec(content[0])!;
  const slug = `${cat}/${name}`;
  const url = `${g.siteBase}/blog/${slug}`;
  if (!g.contractUrls.includes(url)) return { code: BLOCK, reason: `el artículo cambiado (${slug}) no es el del contrato` };

  const [baseSrc, headSrc] = await Promise.all([g.readFile(content[0], g.baseRef), g.readFile(content[0], g.headRef)]);
  const baseMd = baseSrc && contentFromSource(baseSrc);
  const headMd = headSrc && contentFromSource(headSrc);
  if (!baseMd || !headMd) return { code: BLOCK, reason: `no se puede leer el texto de ${slug} en main o en la rama` };

  // Cifras nuevas sin fuente: bloqueo determinista, antes de gastar evaluaciones.
  const unsourced = unsourcedNewFigures(baseMd, headMd);
  if (unsourced.length > 0) return { code: BLOCK, reason: `IA editorial bloquea: ${slug} añade cifras sin fuente (${unsourced.slice(0, 3).map((u) => u.figure).join(", ")})` };

  const headDoc = extractArticleFromMarkdown(headMd, g.siteBase);
  const baseDoc = extractArticleFromMarkdown(baseMd, g.siteBase);
  // La decisión vale para esta pareja exacta main/rama con esta rúbrica, este prompt y este modelo.
  const gateKey = gateCacheKey(baseDoc.text, headDoc.text);
  const cached = await prisma.editorialScore.findFirst({ where: { slug, contentHash: gateKey, kind: "gate" }, orderBy: { createdAt: "desc" } });
  if (cached) return { code: cached.decision === "approve" ? ALLOW : BLOCK, reason: `IA editorial (ya evaluado): ${cached.reason}` };

  const baseHollow = detectHollow(baseDoc.text);
  const headHollow = detectHollow(headDoc.text);
  // Dos evaluaciones independientes de la rama (y una tercera si discrepan más de un punto): vale la
  // más baja, salvo el desempate, que toma la mediana. Un 9 solo cuenta si las dos lo confirman.
  const evalHead = () => evaluateArticle({ url, doc: headDoc, hollow: headHollow, similar: [] }, g.runner);
  const [base, head, head2] = await Promise.all([evaluateArticle({ url, doc: baseDoc, hollow: baseHollow, similar: [] }, g.runner), evalHead(), evalHead()]);
  let headFinal: number;
  if (Math.abs(head.score - head2.score) > DISAGREEMENT) {
    const third = await evalHead();
    headFinal = [head.score, head2.score, third.score].sort((x, y) => x - y)[1];
  } else if (Math.min(head.score, head2.score) >= EXCELLENT) {
    headFinal = combineExcellent(head.score, head2.score);
  } else {
    headFinal = Math.min(head.score, head2.score);
  }

  const d = decide(headFinal, head.criteria);
  const gain = Math.round((headFinal - base.score) * 100) / 100;
  const approve = d.decision === "approve" && gain >= MIN_IMPROVEMENT;
  const reason = approve
    ? `aprueba: ${slug} pasa de ${base.score} a ${headFinal}`
    : d.decision !== "approve"
      ? `bloquea: ${slug} en la rama ${d.reason} (main ${base.score})`
      : `bloquea: ${slug} solo mejora ${gain} (${base.score} → ${headFinal}; hace falta +${MIN_IMPROVEMENT})`;

  const common = { slug, url, rubricVersion: RUBRIC_VERSION, model: EVALUATOR_MODEL, createdAt: g.now };
  await prisma.editorialScore.create({
    data: { ...common, contentHash: hash(baseDoc.text), kind: "gate-base", score: base.score, finalScore: base.score, decision: "baseline", reason: "versión de main en la guarda", criteria: base.criteria as object, deterministic: baseHollow as object, summary: base.summary },
  });
  await prisma.editorialScore.create({
    data: { ...common, contentHash: gateKey, kind: "gate", score: head.score, finalScore: headFinal, decision: approve ? "approve" : "block", reason, criteria: head.criteria as object, deterministic: headHollow as object, summary: head.summary },
  });
  return { code: approve ? ALLOW : BLOCK, reason: `IA editorial ${reason}` };
}
