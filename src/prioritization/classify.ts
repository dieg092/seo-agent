// src/prioritization/classify.ts
import type { Finding } from "./types";
import { expectedCtrForPosition } from "./expectedCtr";

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export function extractSitemapFindings(row: {
  id: string;
  errors: unknown;
  staleEntries: number;
}): Finding[] {
  const findings: Finding[] = [];

  for (const message of asStringArray(row.errors)) {
    if (message.startsWith("El XML del sitemap parece estar mal formado")) {
      findings.push({
        source: "sitemap",
        findingType: "sitemap-malformed",
        stableKeyInput: "sitemap-malformed",
        title: "El sitemap XML está mal formado",
        detail: message,
        sourceRefId: row.id,
      });
    } else if (message.startsWith("URL fuera de dominio en el sitemap: ")) {
      findings.push({
        source: "sitemap",
        findingType: "sitemap-out-of-domain",
        stableKeyInput: message,
        title: message,
        detail: message,
        sourceRefId: row.id,
      });
    } else if (message.startsWith("No se pudo obtener el sitemap: ")) {
      findings.push({
        source: "sitemap",
        findingType: "sitemap-fetch-failed",
        stableKeyInput: "sitemap-fetch-failed",
        title: "No se pudo obtener el sitemap",
        detail: message,
        sourceRefId: row.id,
      });
    } else {
      findings.push({
        source: "sitemap",
        findingType: "sitemap-other",
        stableKeyInput: message,
        title: message,
        detail: message,
        sourceRefId: row.id,
      });
    }
  }

  if (row.staleEntries > 0) {
    findings.push({
      source: "sitemap",
      findingType: "sitemap-stale-entries",
      stableKeyInput: "sitemap-stale-entries",
      title: `${row.staleEntries} URLs del sitemap tienen un lastmod obsoleto (>400 días)`,
      detail: { staleEntries: row.staleEntries },
      sourceRefId: row.id,
    });
  }

  return findings;
}

export function extractRobotsFindings(row: { id: string; errors: unknown }): Finding[] {
  const findings: Finding[] = [];

  for (const message of asStringArray(row.errors)) {
    if (message === "robots.txt no declara ninguna directiva Sitemap:") {
      findings.push({
        source: "robots",
        findingType: "robots-missing-sitemap-directive",
        stableKeyInput: "robots-missing-sitemap-directive",
        title: "robots.txt no declara ninguna directiva Sitemap",
        detail: message,
        sourceRefId: row.id,
      });
    } else if (message.startsWith("robots.txt contiene 'Disallow: /'")) {
      findings.push({
        source: "robots",
        findingType: "robots-blocks-all",
        stableKeyInput: "robots-blocks-all",
        title: "robots.txt bloquea la indexación de todo el sitio",
        detail: message,
        sourceRefId: row.id,
      });
    } else if (message.startsWith("No se pudo obtener robots.txt: ")) {
      findings.push({
        source: "robots",
        findingType: "robots-fetch-failed",
        stableKeyInput: "robots-fetch-failed",
        title: "No se pudo obtener robots.txt",
        detail: message,
        sourceRefId: row.id,
      });
    } else {
      findings.push({
        source: "robots",
        findingType: "robots-other",
        stableKeyInput: message,
        title: message,
        detail: message,
        sourceRefId: row.id,
      });
    }
  }

  return findings;
}

export function extractStructuredDataFindings(
  rows: { id: string; url: string; schemaType: string; isValid: boolean; errors: unknown }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const row of rows) {
    if (row.isValid) continue;

    if (row.schemaType === "none") {
      findings.push({
        source: "structuredData",
        findingType: "structured-data-missing",
        stableKeyInput: `structured-data-missing:${row.url}`,
        title: `Sin datos estructurados en ${row.url}`,
        detail: row.errors,
        sourceRefId: row.id,
      });
    } else if (row.schemaType === "invalid-json") {
      findings.push({
        source: "structuredData",
        findingType: "structured-data-invalid-json",
        stableKeyInput: `structured-data-invalid-json:${row.url}`,
        title: `JSON-LD inválido en ${row.url}`,
        detail: row.errors,
        sourceRefId: row.id,
      });
    } else {
      findings.push({
        source: "structuredData",
        findingType: "structured-data-missing-field",
        stableKeyInput: `structured-data-missing-field:${row.url}:${row.schemaType}`,
        title: `Campos requeridos faltantes en el schema ${row.schemaType} de ${row.url}`,
        detail: row.errors,
        sourceRefId: row.id,
      });
    }
  }

  return findings;
}

const LCP_RED_THRESHOLD_SECONDS = 4;
const CLS_RED_THRESHOLD = 0.25;
const INP_RED_THRESHOLD_MS = 500;
const LOW_SCORE_THRESHOLD = 50;

export function extractPerformanceFindings(
  rows: {
    id: string;
    url: string;
    performanceScore: number | null;
    lcp: number | null;
    cls: number | null;
    inp: number | null;
  }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const row of rows) {
    if (row.lcp !== null && row.lcp > LCP_RED_THRESHOLD_SECONDS) {
      findings.push({
        source: "performance",
        findingType: "performance-lcp-red",
        stableKeyInput: `performance-lcp-red:${row.url}`,
        title: `LCP en rojo (${row.lcp}s) en ${row.url}`,
        detail: { lcp: row.lcp },
        sourceRefId: row.id,
      });
    }
    if (row.cls !== null && row.cls > CLS_RED_THRESHOLD) {
      findings.push({
        source: "performance",
        findingType: "performance-cls-red",
        stableKeyInput: `performance-cls-red:${row.url}`,
        title: `CLS en rojo (${row.cls}) en ${row.url}`,
        detail: { cls: row.cls },
        sourceRefId: row.id,
      });
    }
    if (row.inp !== null && row.inp > INP_RED_THRESHOLD_MS) {
      findings.push({
        source: "performance",
        findingType: "performance-inp-red",
        stableKeyInput: `performance-inp-red:${row.url}`,
        title: `INP en rojo (${row.inp}ms) en ${row.url}`,
        detail: { inp: row.inp },
        sourceRefId: row.id,
      });
    }
    if (row.performanceScore !== null && row.performanceScore < LOW_SCORE_THRESHOLD) {
      findings.push({
        source: "performance",
        findingType: "performance-low-score",
        stableKeyInput: `performance-low-score:${row.url}`,
        title: `Puntuación PageSpeed baja (${row.performanceScore}) en ${row.url}`,
        detail: { performanceScore: row.performanceScore },
        sourceRefId: row.id,
      });
    }
  }

  return findings;
}

export function extractInternalLinkFindings(
  rows: { id: string; sourceSlug: string; targetSlug: string; similarity: number }[]
): Finding[] {
  return rows.map((row) => ({
    source: "internalLinking",
    findingType: "internal-link-suggestion",
    stableKeyInput: `internal-link:${row.sourceSlug}:${row.targetSlug}`,
    title: `Posible enlace interno: ${row.sourceSlug} → ${row.targetSlug} (similitud ${row.similarity.toFixed(2)})`,
    detail: { sourceSlug: row.sourceSlug, targetSlug: row.targetSlug, similarity: row.similarity },
    sourceRefId: row.id,
  }));
}

const QUERY_GAP_MIN_IMPRESSIONS = 100;
const QUERY_GAP_MAX_CTR = 0.01;
const QUERY_GAP_MIN_POSITION = 10;

export function extractQueryGapFindings(
  rows: { page: string; query: string; impressions: number; clicks: number; position: number }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const row of rows) {
    const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
    if (row.impressions >= QUERY_GAP_MIN_IMPRESSIONS && ctr < QUERY_GAP_MAX_CTR && row.position > QUERY_GAP_MIN_POSITION) {
      findings.push({
        source: "content",
        findingType: "content-query-gap",
        stableKeyInput: `content-query-gap:${row.page}:${row.query}`,
        title: `"${row.query}" tiene ${row.impressions} impresiones pero posición ${row.position.toFixed(1)} en ${row.page}`,
        detail: row,
        sourceRefId: `${row.page}:${row.query}`,
      });
    }
  }

  return findings;
}

const DECLINE_THRESHOLD = 0.3;

export function extractDecliningFindings(
  recentAvg: { page: string; clicks: number }[],
  priorAvg: { page: string; clicks: number }[]
): Finding[] {
  const findings: Finding[] = [];
  const priorByPage = new Map(priorAvg.map((row) => [row.page, row.clicks]));

  for (const recent of recentAvg) {
    const prior = priorByPage.get(recent.page);
    if (prior === undefined || prior === 0) continue;

    const decline = (prior - recent.clicks) / prior;
    if (decline >= DECLINE_THRESHOLD) {
      findings.push({
        source: "content",
        findingType: "content-declining",
        stableKeyInput: `content-declining:${recent.page}`,
        title: `${recent.page} ha bajado un ${(decline * 100).toFixed(0)}% en clics (${prior} → ${recent.clicks})`,
        detail: { page: recent.page, priorClicks: prior, recentClicks: recent.clicks, decline },
        sourceRefId: recent.page,
      });
    }
  }

  return findings;
}

export function extractCannibalizationFindings(
  rows: { page: string; query: string; date: Date }[]
): Finding[] {
  const pagesByQuery = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!pagesByQuery.has(row.query)) pagesByQuery.set(row.query, new Set());
    pagesByQuery.get(row.query)!.add(row.page);
  }

  const findings: Finding[] = [];

  for (const [query, pages] of pagesByQuery) {
    if (pages.size >= 2) {
      const pageList = Array.from(pages).sort();
      findings.push({
        source: "content",
        findingType: "content-cannibalization",
        stableKeyInput: `content-cannibalization:${query}`,
        title: `"${query}" recibe impresiones desde ${pages.size} páginas distintas: ${pageList.join(", ")}`,
        detail: { query, pages: pageList },
        sourceRefId: query,
      });
    }
  }

  return findings;
}

const TEMPLATE_LOW_SCORE_THRESHOLD = 50;

export function extractSiteArchitectureFindings(deps: {
  templatePerformance: { url: string; scores: number[] }[];
  nearDuplicates: { slugA: string; slugB: string; similarity: number }[];
  missingTemplates: { province: string; impressions: number }[];
}): Finding[] {
  const findings: Finding[] = [];

  for (const entry of deps.templatePerformance) {
    if (entry.scores.every((s) => s < TEMPLATE_LOW_SCORE_THRESHOLD)) {
      findings.push({
        source: "siteArchitecture",
        findingType: "site-architecture-template-performance",
        stableKeyInput: `site-architecture-template-performance:${entry.url}`,
        title: `Rendimiento consistentemente bajo en ${entry.url} (últimas puntuaciones: ${entry.scores.join(", ")})`,
        detail: entry,
        sourceRefId: entry.url,
      });
    }
  }

  for (const pair of deps.nearDuplicates) {
    findings.push({
      source: "siteArchitecture",
      findingType: "site-architecture-near-duplicate",
      stableKeyInput: `site-architecture-near-duplicate:${pair.slugA}:${pair.slugB}`,
      title: `Posible contenido casi duplicado: ${pair.slugA} / ${pair.slugB} (similitud ${pair.similarity.toFixed(2)})`,
      detail: pair,
      sourceRefId: `${pair.slugA}:${pair.slugB}`,
    });
  }

  for (const candidate of deps.missingTemplates) {
    findings.push({
      source: "siteArchitecture",
      findingType: "site-architecture-missing-template",
      stableKeyInput: `site-architecture-missing-template:${candidate.province}`,
      title: `"${candidate.province}" tiene ${candidate.impressions} impresiones sin página provincial dedicada`,
      detail: candidate,
      sourceRefId: candidate.province,
    });
  }

  return findings;
}

// Sección A del brief: CTR bajo en primera página. Página ya posiciona 1-10
// pero se clickea muy por debajo de lo esperado para esa posición — el arreglo
// típico es title/meta description/H1, no contenido nuevo.
const LOW_CTR_MIN_IMPRESSIONS = 20;
const LOW_CTR_MIN_POSITION = 1;
const LOW_CTR_MAX_POSITION = 10;
const LOW_CTR_RATIO_THRESHOLD = 0.6;

export function extractLowCtrFindings(
  rows: { page: string; impressions: number; clicks: number; avgPosition: number }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const row of rows) {
    if (row.impressions < LOW_CTR_MIN_IMPRESSIONS) continue;
    if (row.avgPosition < LOW_CTR_MIN_POSITION || row.avgPosition > LOW_CTR_MAX_POSITION) continue;

    const ctr = row.impressions > 0 ? row.clicks / row.impressions : 0;
    const expected = expectedCtrForPosition(row.avgPosition);
    if (ctr < expected * LOW_CTR_RATIO_THRESHOLD) {
      findings.push({
        source: "content",
        findingType: "content-low-ctr",
        stableKeyInput: `content-low-ctr:${row.page}`,
        title: `${row.page} tiene CTR ${(ctr * 100).toFixed(2)}% en posición ${row.avgPosition.toFixed(1)} (esperado ${(expected * 100).toFixed(2)}%)`,
        detail: { page: row.page, impressions: row.impressions, clicks: row.clicks, avgPosition: row.avgPosition, ctr, expectedCtr: expected },
        sourceRefId: row.page,
      });
    }
  }

  return findings;
}

// Sección B del brief: páginas cerca de primera página (11-20) con impresiones
// que no caen. El arreglo típico es ampliar contenido/FAQs/enlazado, no solo el title.
const NEAR_PAGE1_MIN_IMPRESSIONS = 30;
const NEAR_PAGE1_MIN_POSITION = 11;
const NEAR_PAGE1_MAX_POSITION = 20;

export function extractNearPage1Findings(
  current: { page: string; impressions: number; avgPosition: number }[],
  prior: { page: string; impressions: number }[]
): Finding[] {
  const findings: Finding[] = [];
  const priorByPage = new Map(prior.map((row) => [row.page, row.impressions]));

  for (const row of current) {
    if (row.impressions < NEAR_PAGE1_MIN_IMPRESSIONS) continue;
    if (row.avgPosition < NEAR_PAGE1_MIN_POSITION || row.avgPosition > NEAR_PAGE1_MAX_POSITION) continue;

    // Sin dato del periodo anterior, no hay caída que descartar: se trata como
    // tendencia estable/creciente (página nueva o que antes no tenía impresiones).
    const priorImpressions = priorByPage.get(row.page) ?? 0;
    if (row.impressions < priorImpressions) continue;

    findings.push({
      source: "content",
      findingType: "content-near-page1",
      stableKeyInput: `content-near-page1:${row.page}`,
      title: `${row.page} está en posición ${row.avgPosition.toFixed(1)} con ${row.impressions} impresiones — cerca de primera página`,
      detail: { page: row.page, impressions: row.impressions, avgPosition: row.avgPosition, priorImpressions },
      sourceRefId: row.page,
    });
  }

  return findings;
}

// Sección C del brief: posiciones 21-40 con impresiones altas. Nunca se
// resuelve solo cambiando el título — requiere revisar profundidad de
// contenido, subintenciones, enlazado interno y posible canibalización.
const HIGH_IMPRESSION_LOW_POSITION_MIN_IMPRESSIONS = 75;
const HIGH_IMPRESSION_LOW_POSITION_MIN_POSITION = 21;
const HIGH_IMPRESSION_LOW_POSITION_MAX_POSITION = 40;

export function extractHighImpressionLowPositionFindings(
  rows: { page: string; impressions: number; avgPosition: number }[]
): Finding[] {
  const findings: Finding[] = [];

  for (const row of rows) {
    if (row.impressions < HIGH_IMPRESSION_LOW_POSITION_MIN_IMPRESSIONS) continue;
    if (
      row.avgPosition < HIGH_IMPRESSION_LOW_POSITION_MIN_POSITION ||
      row.avgPosition > HIGH_IMPRESSION_LOW_POSITION_MAX_POSITION
    )
      continue;

    findings.push({
      source: "content",
      findingType: "content-high-impression-low-position",
      stableKeyInput: `content-high-impression-low-position:${row.page}`,
      title: `${row.page} tiene ${row.impressions} impresiones pero posición ${row.avgPosition.toFixed(1)} — requiere análisis de profundidad de contenido`,
      detail: { page: row.page, impressions: row.impressions, avgPosition: row.avgPosition },
      sourceRefId: row.page,
    });
  }

  return findings;
}
