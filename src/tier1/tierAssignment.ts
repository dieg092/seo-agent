import type { FindingType } from "../prioritization/types";

const TIER: Record<FindingType, 1 | 2 | 3> = {
  "robots-missing-sitemap-directive": 1,
  "robots-blocks-all": 1,
  "sitemap-malformed": 3,
  "sitemap-out-of-domain": 2,
  "sitemap-fetch-failed": 3,
  "sitemap-stale-entries": 3,
  "sitemap-other": 3,
  "robots-fetch-failed": 3,
  "robots-other": 3,
  "structured-data-missing": 2,
  "structured-data-invalid-json": 2,
  "structured-data-missing-field": 2,
  "performance-lcp-red": 3,
  "performance-cls-red": 3,
  "performance-inp-red": 3,
  "performance-low-score": 3,
  "internal-link-suggestion": 2,
  "content-cannibalization": 3,
  "content-declining": 3,
  "content-query-gap": 3,
};

export function getTier(findingType: FindingType): 1 | 2 | 3 {
  return TIER[findingType];
}
