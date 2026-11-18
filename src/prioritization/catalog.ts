// src/prioritization/catalog.ts
// Atributos por tipo de hallazgo que usan la prioridad (§12.2), los carriles
// (§12.3) y la confirmación (§6). Sale del Anexo B; los tipos actuales que el
// Anexo B no nombra se asimilan al más parecido (ver docs/lifecycle.md).
import type { FindingType } from "./types";

export type Severity = "critical" | "high" | "medium" | "low";
export type ConfidenceKind = "observed" | "derived" | "heuristic";
export type Autonomy = "A1" | "A2" | "A3";
export type Lane = "urgent" | "technical" | "content" | "links" | "strategy";

export interface CatalogEntry {
  severity: Severity;
  confidence: ConfidenceKind;
  autonomy: Autonomy;
  lane: Lane;
  /** Operación del catálogo A1 (§8.2) o null si no hay. */
  operation: string | null;
  /** Riesgo de perder la indexación de páginas con valor (urgency = 3). */
  indexationRisk: boolean;
}

const CATALOG: Record<FindingType, CatalogEntry> = {
  "sitemap-malformed": { severity: "high", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "sitemap-out-of-domain": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "sitemap-fetch-failed": { severity: "high", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "sitemap-stale-entries": { severity: "low", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "sitemap-other": { severity: "low", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "robots-missing-sitemap-directive": { severity: "medium", confidence: "observed", autonomy: "A1", lane: "technical", operation: "robots-restore-sitemap-directive", indexationRisk: false },
  "robots-blocks-all": { severity: "critical", confidence: "observed", autonomy: "A1", lane: "urgent", operation: "revert-change", indexationRisk: true },
  "robots-fetch-failed": { severity: "high", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "robots-other": { severity: "low", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  // jsonld-fix no añade tipos: si falta el bloque entero es A2.
  "structured-data-missing": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "structured-data-invalid-json": { severity: "medium", confidence: "observed", autonomy: "A1", lane: "technical", operation: "jsonld-fix", indexationRisk: false },
  "structured-data-missing-field": { severity: "medium", confidence: "observed", autonomy: "A1", lane: "technical", operation: "jsonld-fix", indexationRisk: false },
  // perf-lab-poor del Anexo B.
  "performance-lcp-red": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "performance-cls-red": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "performance-inp-red": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "performance-low-score": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  // Sale de similitud de embeddings (heurística): nunca A1 (Anexo B.1).
  "internal-link-suggestion": { severity: "low", confidence: "heuristic", autonomy: "A2", lane: "links", operation: "internal-links-batch", indexationRisk: false },
  "content-cannibalization": { severity: "medium", confidence: "derived", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  // visibility-declining: investigación de solo lectura.
  "content-declining": { severity: "medium", confidence: "derived", autonomy: "A1", lane: "content", operation: "investigation", indexationRisk: false },
  "content-query-gap": { severity: "low", confidence: "heuristic", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  "content-low-ctr": { severity: "medium", confidence: "derived", autonomy: "A1", lane: "content", operation: "meta-title-description", indexationRisk: false },
  "content-near-page1": { severity: "medium", confidence: "derived", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  "content-high-impression-low-position": { severity: "low", confidence: "derived", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  "site-architecture-template-performance": { severity: "medium", confidence: "derived", autonomy: "A2", lane: "strategy", operation: null, indexationRisk: false },
  "site-architecture-near-duplicate": { severity: "medium", confidence: "heuristic", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  "site-architecture-missing-template": { severity: "medium", confidence: "derived", autonomy: "A2", lane: "strategy", operation: null, indexationRisk: false },
  // Anexo B, fase 2c (src/detectors/annexB.ts). Donde el Anexo B da dos
  // severidades según el valor de la página, aquí va la menor: el valor ya
  // entra en la prioridad (§12.2).
  "index-dropped": { severity: "high", confidence: "observed", autonomy: "A2", lane: "urgent", operation: null, indexationRisk: true },
  "index-not-indexed": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "index-canonical-mismatch": { severity: "high", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "index-blocked": { severity: "critical", confidence: "observed", autonomy: "A2", lane: "urgent", operation: null, indexationRisk: true },
  "rich-results-error": { severity: "medium", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "index-bloat": { severity: "low", confidence: "derived", autonomy: "A2", lane: "strategy", operation: null, indexationRisk: false },
  "noindex-commercial": { severity: "high", confidence: "observed", autonomy: "A2", lane: "strategy", operation: null, indexationRisk: true },
  "sitemap-gsc-error": { severity: "high", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "sitemap-dead-url": { severity: "high", confidence: "observed", autonomy: "A1", lane: "technical", operation: "sitemap-drop-dead-url", indexationRisk: false },
  "private-page-exposed": { severity: "critical", confidence: "observed", autonomy: "A3", lane: "urgent", operation: "manual", indexationRisk: false },
  "meta-missing": { severity: "high", confidence: "observed", autonomy: "A1", lane: "content", operation: "meta-title-description", indexationRisk: false },
  "meta-duplicate": { severity: "medium", confidence: "observed", autonomy: "A1", lane: "content", operation: "meta-title-description", indexationRisk: false },
  "h1-missing-or-multiple": { severity: "low", confidence: "observed", autonomy: "A2", lane: "technical", operation: null, indexationRisk: false },
  "broken-internal-link": { severity: "medium", confidence: "observed", autonomy: "A1", lane: "links", operation: "broken-internal-link-fix", indexationRisk: false },
  "link-to-redirect": { severity: "low", confidence: "observed", autonomy: "A1", lane: "links", operation: "broken-internal-link-fix", indexationRisk: false },
  "orphan-page": { severity: "medium", confidence: "observed", autonomy: "A1", lane: "links", operation: "internal-links-batch", indexationRisk: false },
  "deep-page": { severity: "low", confidence: "derived", autonomy: "A2", lane: "links", operation: null, indexationRisk: false },
  // Fase 5 (§16.3): sale de páginas de competidores, entrada contaminada: A2 y sin operación.
  "competitor-gap": { severity: "low", confidence: "heuristic", autonomy: "A2", lane: "strategy", operation: null, indexationRisk: false },
  // A1 porque la aprobación la da la IA editorial en la guarda premerge (B5), no el fundador.
  "content-intent-mismatch": { severity: "medium", confidence: "derived", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  "content-seasonal": { severity: "low", confidence: "derived", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
  "editorial-low-score": { severity: "medium", confidence: "heuristic", autonomy: "A1", lane: "content", operation: "content-improve", indexationRisk: false },
  "visibility-declining": { severity: "medium", confidence: "derived", autonomy: "A1", lane: "content", operation: "investigation", indexationRisk: false },
  "segment-declining": { severity: "low", confidence: "derived", autonomy: "A1", lane: "content", operation: "investigation", indexationRisk: false },
  "image-opportunity": { severity: "low", confidence: "derived", autonomy: "A1", lane: "content", operation: "image-alt", indexationRisk: false },
  "data-quality-gap": { severity: "high", confidence: "observed", autonomy: "A3", lane: "technical", operation: "manual", indexationRisk: false },
  "collector-failing": { severity: "high", confidence: "observed", autonomy: "A3", lane: "technical", operation: "manual", indexationRisk: false },
  "funnel-drop": { severity: "high", confidence: "derived", autonomy: "A3", lane: "strategy", operation: "manual", indexationRisk: false },
  // Fase 5 (src/strategy/keywords.ts): propuestas, nunca código directo.
  "commercial-page-missing": { severity: "high", confidence: "derived", autonomy: "A2", lane: "strategy", operation: null, indexationRisk: false },
  "topic-cluster-gap": { severity: "medium", confidence: "derived", autonomy: "A2", lane: "content", operation: null, indexationRisk: false },
};

export function getCatalogEntry(findingType: FindingType): CatalogEntry {
  return CATALOG[findingType];
}

/** Críticos: se abren con 1 confirmación (§6). */
export function isCritical(findingType: FindingType): boolean {
  return CATALOG[findingType].severity === "critical";
}
