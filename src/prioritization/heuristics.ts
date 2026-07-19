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
};

export function getHeuristic(findingType: FindingType): Heuristic {
  return HEURISTICS[findingType];
}
