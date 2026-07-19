import { getEnv } from "../env";

export interface PerformanceEntry {
  url: string;
  performanceScore: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  errors: string[];
}

interface PsiResponse {
  lighthouseResult?: {
    categories?: { performance?: { score?: number } };
    audits?: {
      "largest-contentful-paint"?: { numericValue?: number };
      "cumulative-layout-shift"?: { numericValue?: number };
    };
  };
  loadingExperience?: {
    metrics?: {
      INTERACTION_TO_NEXT_PAINT?: { percentile?: number };
    };
  };
}

export async function auditPerformance(deps: {
  urls: string[];
  fetchPsi?: (url: string) => Promise<unknown>;
}): Promise<PerformanceEntry[]> {
  const fetchPsi =
    deps.fetchPsi ??
    (async (url: string) => {
      const apiKey = getEnv("PAGESPEED_API_KEY");
      const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${apiKey}`;
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`PSI request failed: ${response.status}`);
      }
      return response.json();
    });

  const results: PerformanceEntry[] = [];

  for (const url of deps.urls) {
    try {
      const raw = (await fetchPsi(url)) as PsiResponse;
      const scoreRaw = raw.lighthouseResult?.categories?.performance?.score;
      const lcpMs = raw.lighthouseResult?.audits?.["largest-contentful-paint"]?.numericValue;
      const cls = raw.lighthouseResult?.audits?.["cumulative-layout-shift"]?.numericValue;
      const inp = raw.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile;

      results.push({
        url,
        performanceScore: scoreRaw !== undefined ? Math.round(scoreRaw * 100) : null,
        lcp: lcpMs !== undefined ? lcpMs / 1000 : null,
        cls: cls ?? null,
        inp: inp ?? null,
        errors: [],
      });
    } catch (error) {
      results.push({
        url,
        performanceScore: null,
        lcp: null,
        cls: null,
        inp: null,
        errors: [`No se pudo obtener PageSpeed Insights: ${(error as Error).message}`],
      });
    }
  }

  return results;
}
