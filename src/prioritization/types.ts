// src/prioritization/types.ts
export type FindingSource = "sitemap" | "robots" | "structuredData" | "performance";

export type FindingType =
  | "sitemap-malformed"
  | "sitemap-out-of-domain"
  | "sitemap-fetch-failed"
  | "sitemap-stale-entries"
  | "sitemap-other"
  | "robots-missing-sitemap-directive"
  | "robots-blocks-all"
  | "robots-fetch-failed"
  | "robots-other"
  | "structured-data-missing"
  | "structured-data-invalid-json"
  | "structured-data-missing-field"
  | "performance-lcp-red"
  | "performance-cls-red"
  | "performance-inp-red"
  | "performance-low-score";

export interface Finding {
  source: FindingSource;
  findingType: FindingType;
  stableKeyInput: string;
  title: string;
  detail: unknown;
  sourceRefId: string;
}
