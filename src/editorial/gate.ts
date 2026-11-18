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
import { EVALUATOR_MODEL, evaluateArticle, type Runner } from "./evaluator";
import { EXCELLENT, RUBRIC_VERSION, combineExcellent, decide } from "./rubric";

export const MIN_IMPROVEMENT = 0.5;
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

export async function editorialGate(g: GateInput): Promise<GuardDecision> {
  const calibration = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  if (calibration?.status !== "ok") return { code: HOLD, reason: `IA editorial suspendida (calibración ${calibration?.status ?? "pendiente"})` };

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

  const headDoc = extractArticleFromMarkdown(headMd, g.siteBase);
  const headHash = hash(headDoc.text);
  const cached = await prisma.editorialScore.findFirst({ where: { slug, contentHash: headHash, kind: "gate" }, orderBy: { createdAt: "desc" } });
  if (cached) return { code: cached.decision === "approve" ? ALLOW : BLOCK, reason: `IA editorial (ya evaluado): ${cached.reason}` };

  const baseDoc = extractArticleFromMarkdown(baseMd, g.siteBase);
  const baseHollow = detectHollow(baseDoc.text);
  const headHollow = detectHollow(headDoc.text);
  const [base, head] = await Promise.all([
    evaluateArticle({ url, doc: baseDoc, hollow: baseHollow, similar: [] }, g.runner),
    evaluateArticle({ url, doc: headDoc, hollow: headHollow, similar: [] }, g.runner),
  ]);
  let headFinal = head.score;
  if (head.score >= EXCELLENT) {
    const second = await evaluateArticle({ url, doc: headDoc, hollow: headHollow, similar: [] }, g.runner);
    headFinal = combineExcellent(head.score, second.score);
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
    data: { ...common, contentHash: headHash, kind: "gate", score: head.score, finalScore: headFinal, decision: approve ? "approve" : "block", reason, criteria: head.criteria as object, deterministic: headHollow as object, summary: head.summary },
  });
  return { code: approve ? ALLOW : BLOCK, reason: `IA editorial ${reason}` };
}
