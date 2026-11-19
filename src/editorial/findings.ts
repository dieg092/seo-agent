// src/editorial/findings.ts
// Artículos que la IA editorial bloquea: hallazgo A2 para mejorar lo que ya existe
// (§16.4: se prioriza mejorar sobre escribir nuevo).
import type { Finding } from "../prioritization/types";
import { CRITERIA, type CriterionKey } from "./rubric";
import { PREPUBLISH_FREEZE_DAYS, PREPUBLISH_MIN_LEAD_DAYS, daysUntil } from "./scheduled";

export interface LatestScore {
  slug: string;
  url: string;
  contentHash: string;
  finalScore: number;
  decision: string;
  reason: string;
  criteria: Record<string, { score: number; note: string }>;
}

export const MAX_EDITORIAL_FINDINGS = 5;
export const MAX_PREPUBLISH_FINDINGS = 5;

export interface PrepublishScore extends LatestScore {
  deterministic: { publishedAt?: string } | null;
}

/**
 * Programados que la revisión previa no aprueba y que salen dentro de PREPUBLISH_MIN_LEAD_DAYS o
 * más: hallazgo para corregirlos antes de que se publiquen, el más próximo primero.
 */
export function extractPrepublishFindings(latest: PrepublishScore[], now: Date): Finding[] {
  return latest
    .filter((s) => s.decision === "block" && s.deterministic?.publishedAt && daysUntil(s.deterministic.publishedAt, now) >= PREPUBLISH_MIN_LEAD_DAYS)
    .sort((a, b) => a.deterministic!.publishedAt!.localeCompare(b.deterministic!.publishedAt!) || a.slug.localeCompare(b.slug))
    .slice(0, MAX_PREPUBLISH_FINDINGS)
    .map((s) => {
      const weakest = CRITERIA.map((c) => ({ key: c.key as CriterionKey, label: c.label, ...(s.criteria[c.key] ?? { score: 10, note: "" }) }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 5);
      return {
        source: "editorial" as const,
        findingType: "editorial-prepublish" as const,
        stableKeyInput: `editorial-prepublish:${s.slug}:${s.contentHash.slice(0, 16)}`,
        title: `Corregir antes de publicar ${s.slug} (sale el ${s.deterministic!.publishedAt}, nota ${s.finalScore.toFixed(1)})`,
        detail: {
          page: s.url,
          publishedAt: s.deterministic!.publishedAt,
          mustMergeBefore: `${PREPUBLISH_FREEZE_DAYS} días antes de publicarse`,
          score: s.finalScore,
          reason: s.reason,
          weakest: weakest.map((w) => ({ criterion: w.key, label: w.label, score: w.score, note: w.note })),
        },
        sourceRefId: s.url,
      };
    });
}

export function extractEditorialFindings(latest: LatestScore[]): Finding[] {
  return latest
    .filter((s) => s.decision === "block")
    .sort((a, b) => a.finalScore - b.finalScore || a.slug.localeCompare(b.slug))
    .slice(0, MAX_EDITORIAL_FINDINGS)
    .map((s) => {
      const weakest = CRITERIA.map((c) => ({ key: c.key as CriterionKey, label: c.label, ...(s.criteria[c.key] ?? { score: 10, note: "" }) }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 5);
      return {
        source: "editorial" as const,
        findingType: "editorial-low-score" as const,
        stableKeyInput: `editorial-low-score:${s.slug}:${s.contentHash.slice(0, 16)}`,
        title: `Mejorar el artículo ${s.slug} (nota editorial ${s.finalScore.toFixed(1)})`,
        detail: {
          page: s.url,
          score: s.finalScore,
          reason: s.reason,
          weakest: weakest.map((w) => ({ criterion: w.key, label: w.label, score: w.score, note: w.note })),
        },
        sourceRefId: s.url,
      };
    });
}
