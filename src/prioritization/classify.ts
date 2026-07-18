// src/prioritization/classify.ts
import type { Finding } from "./types";

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
