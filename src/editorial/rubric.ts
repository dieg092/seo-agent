// src/editorial/rubric.ts
// Rúbrica editorial (§16.4): 20 criterios de 0 a 10 con pesos en el código. Los de
// riesgo puntúan al revés (10 = sin riesgo) para que la nota sea una media ponderada
// homogénea. Un criterio sin evidencia verificable no pasa de 6.

export const RUBRIC_VERSION = "2026-11-18";

export const CRITERIA = [
  { key: "intencion", weight: 8, label: "Responde a la intención de búsqueda" },
  { key: "utilidad", weight: 8, label: "Utilidad práctica para quien organiza su boda" },
  { key: "originalidad", weight: 7, label: "Aporta algo propio (datos, ejemplos, criterio) y no repite lo de siempre" },
  { key: "precision", weight: 8, label: "Precisión de datos, precios, plazos y hechos" },
  { key: "naturalidad", weight: 5, label: "Suena escrito por una persona, sin muletillas ni fórmulas" },
  { key: "profundidad", weight: 5, label: "Profundidad suficiente para el tema" },
  { key: "claridad", weight: 5, label: "Claridad de la redacción" },
  { key: "estructura", weight: 4, label: "Estructura de encabezados y orden lógico" },
  { key: "cobertura", weight: 5, label: "Cubre los subtemas que espera el lector" },
  { key: "enlazado", weight: 4, label: "Enlaces internos útiles y bien colocados" },
  { key: "fuentes", weight: 4, label: "Cita fuentes o justifica de dónde salen los datos" },
  { key: "visuales", weight: 3, label: "Imágenes, tablas o listas que ayudan" },
  { key: "movil", weight: 3, label: "Lectura cómoda en móvil (párrafos cortos, tablas manejables)" },
  { key: "coherenciaProducto", weight: 6, label: "Coherencia con lo que ofrece miwebdeboda" },
  { key: "potencialComercial", weight: 5, label: "Lleva de forma natural al producto" },
  { key: "riesgoCanibalizacion", weight: 4, label: "Sin riesgo de canibalizar otro artículo (10 = sin riesgo)" },
  { key: "riesgoGenerico", weight: 6, label: "Sin contenido genérico intercambiable (10 = sin riesgo)" },
  { key: "afirmacionesSinJustificar", weight: 4, label: "Sin afirmaciones sin justificar (10 = ninguna)" },
  { key: "informacionObsoleta", weight: 3, label: "Sin información obsoleta (10 = todo vigente)" },
  { key: "redundancia", weight: 3, label: "Sin repeticiones ni relleno (10 = nada redundante)" },
] as const;

export type CriterionKey = (typeof CRITERIA)[number]["key"];
export const CRITERION_KEYS = CRITERIA.map((c) => c.key) as CriterionKey[];

/** Sin evidencia verificable, el criterio no supera esta nota. */
export const NO_EVIDENCE_CAP = 6;
/** Con fórmulas vacías marcadas por la capa determinista, naturalidad y genérico no la superan. */
export const HOLLOW_CAP = 5;
export const APPROVE_MIN = 7;
/** Ningún criterio por debajo de esto, aunque la media llegue. */
export const CRITERION_FLOOR = 4;
export const EXCELLENT = 9;

export interface CriterionScore {
  score: number;
  evidence: string[];
  note: string;
}
export type CriteriaScores = Record<CriterionKey, CriterionScore>;

export function weightedScore(c: Record<CriterionKey, { score: number }>): number {
  let sum = 0;
  let w = 0;
  for (const k of CRITERIA) {
    sum += c[k.key].score * k.weight;
    w += k.weight;
  }
  return Math.round((sum / w) * 100) / 100;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[«»"“”'‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Una evidencia vale si es una cita literal (≥ 12 caracteres) del texto o uno de los
 * hechos estructurales que se le dieron al evaluador. Así no puede inventarse frases.
 */
export function verifyEvidence(evidence: string[], text: string, facts: string[]): string[] {
  const t = norm(text);
  const f = new Set(facts.map(norm));
  return evidence.filter((e) => {
    const n = norm(e).replace(/^\.{3}|\.{3}$/g, "").trim();
    return (n.length >= 12 && t.includes(n)) || f.has(n);
  });
}

/** Aplica los topes: evidencia no verificable y fórmulas vacías. */
export function applyCaps(raw: CriteriaScores, text: string, facts: string[], hollow: boolean): CriteriaScores {
  const out = {} as CriteriaScores;
  for (const k of CRITERION_KEYS) {
    const r = raw[k];
    const evidence = verifyEvidence(r.evidence, text, facts);
    let score = Math.max(0, Math.min(10, r.score));
    if (evidence.length === 0) score = Math.min(score, NO_EVIDENCE_CAP);
    if (hollow && (k === "naturalidad" || k === "riesgoGenerico")) score = Math.min(score, HOLLOW_CAP);
    out[k] = { score, evidence, note: r.note };
  }
  return out;
}

export type Decision = "approve" | "block";

export function decide(score: number, criteria: Record<CriterionKey, { score: number }>): { decision: Decision; reason: string } {
  const low = CRITERION_KEYS.filter((k) => criteria[k].score < CRITERION_FLOOR);
  if (low.length) return { decision: "block", reason: `criterios por debajo de ${CRITERION_FLOOR}: ${low.join(", ")}` };
  if (score < APPROVE_MIN) return { decision: "block", reason: `nota ${score} < ${APPROVE_MIN}` };
  return { decision: "approve", reason: `nota ${score}` };
}

/** Una nota ≥ 9 solo cuenta si la confirman dos evaluaciones independientes ≥ 9. */
export function combineExcellent(first: number, second: number | null): number {
  if (first < EXCELLENT) return first;
  if (second === null) return first;
  if (second >= EXCELLENT) return Math.round(((first + second) / 2) * 100) / 100;
  return Math.min(8.9, Math.round(((first + second) / 2) * 100) / 100);
}
