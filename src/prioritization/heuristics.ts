// src/prioritization/heuristics.ts
import type { FindingType } from "./types";

interface Heuristic {
  impactScore: number;
  effortScore: number;
}

const HEURISTICS: Record<FindingType, Heuristic> = {
  "sitemap-malformed": { impactScore: 8, effortScore: 3 },
  "sitemap-out-of-domain": { impactScore: 6, effortScore: 2 },
  "sitemap-fetch-failed": { impactScore: 8, effortScore: 3 },
  "sitemap-stale-entries": { impactScore: 2, effortScore: 1 },
  "sitemap-other": { impactScore: 3, effortScore: 3 },
  "robots-missing-sitemap-directive": { impactScore: 4, effortScore: 1 },
  "robots-blocks-all": { impactScore: 10, effortScore: 1 },
  "robots-fetch-failed": { impactScore: 8, effortScore: 3 },
  "robots-other": { impactScore: 3, effortScore: 3 },
  "structured-data-missing": { impactScore: 5, effortScore: 4 },
  "structured-data-invalid-json": { impactScore: 4, effortScore: 3 },
  "structured-data-missing-field": { impactScore: 3, effortScore: 3 },
  "performance-lcp-red": { impactScore: 7, effortScore: 6 },
  "performance-cls-red": { impactScore: 7, effortScore: 6 },
  "performance-inp-red": { impactScore: 7, effortScore: 6 },
  "performance-low-score": { impactScore: 5, effortScore: 6 },
  "internal-link-suggestion": { impactScore: 4, effortScore: 2 },
  "content-cannibalization": { impactScore: 6, effortScore: 7 },
  "content-declining": { impactScore: 6, effortScore: 6 },
  "content-query-gap": { impactScore: 5, effortScore: 5 },
  "content-low-ctr": { impactScore: 7, effortScore: 2 },
  "content-near-page1": { impactScore: 7, effortScore: 5 },
  "content-high-impression-low-position": { impactScore: 6, effortScore: 7 },
  "site-architecture-template-performance": { impactScore: 7, effortScore: 8 },
  "site-architecture-near-duplicate": { impactScore: 5, effortScore: 7 },
  "site-architecture-missing-template": { impactScore: 6, effortScore: 9 },
  // Anexo B, fase 2c: esfuerzo de la tabla del anexo.
  "index-dropped": { impactScore: 9, effortScore: 3 },
  "index-not-indexed": { impactScore: 6, effortScore: 4 },
  "index-canonical-mismatch": { impactScore: 6, effortScore: 3 },
  "index-blocked": { impactScore: 9, effortScore: 2 },
  "rich-results-error": { impactScore: 4, effortScore: 3 },
  "index-bloat": { impactScore: 3, effortScore: 4 },
  "noindex-commercial": { impactScore: 8, effortScore: 3 },
  "sitemap-gsc-error": { impactScore: 7, effortScore: 2 },
  "sitemap-dead-url": { impactScore: 5, effortScore: 1 },
  "private-page-exposed": { impactScore: 10, effortScore: 1 },
  "meta-missing": { impactScore: 6, effortScore: 1 },
  "meta-duplicate": { impactScore: 5, effortScore: 2 },
  "h1-missing-or-multiple": { impactScore: 3, effortScore: 2 },
  "broken-internal-link": { impactScore: 5, effortScore: 1 },
  "link-to-redirect": { impactScore: 2, effortScore: 1 },
  "orphan-page": { impactScore: 5, effortScore: 2 },
  "deep-page": { impactScore: 3, effortScore: 3 },
  "visibility-declining": { impactScore: 6, effortScore: 6 },
  "segment-declining": { impactScore: 4, effortScore: 6 },
  "image-opportunity": { impactScore: 3, effortScore: 1 },
  "data-quality-gap": { impactScore: 6, effortScore: 2 },
  "collector-failing": { impactScore: 7, effortScore: 2 },
  "funnel-drop": { impactScore: 8, effortScore: 5 },
  "commercial-page-missing": { impactScore: 8, effortScore: 7 },
  "topic-cluster-gap": { impactScore: 6, effortScore: 6 },
};

export function getHeuristic(findingType: FindingType): Heuristic {
  return HEURISTICS[findingType];
}
