// src/strategy/intentSignals.ts
// Dos detectores de §16.2 que faltaban:
//   - intención que no encaja: buena posición, CTR muy por debajo del esperado y poca
//     interacción orgánica (GA4). No es el título: la página no da lo que se busca;
//   - estacional: consultas que el año pasado subieron mucho en los próximos 60 días.
//     Sale de nuestro propio histórico (sin Google Trends); hasta tener 13 meses de
//     datos no dice nada.
import { expectedCtrForPosition } from "../prioritization/expectedCtr";
import type { Finding } from "../prioritization/types";

export const MISMATCH_MAX_POSITION = 5;
export const MISMATCH_MIN_IMPRESSIONS = 200;
export const MISMATCH_CTR_RATIO = 0.5;
export const MISMATCH_MIN_SESSIONS = 20;
export const MISMATCH_MAX_ENGAGEMENT = 0.45;

export interface PageSignals {
  page: string;
  impressions: number;
  clicks: number;
  position: number;
  sessions: number;
  engagedSessions: number;
}

export function extractIntentMismatchFindings(rows: PageSignals[]): Finding[] {
  return rows
    .filter((r) => r.impressions >= MISMATCH_MIN_IMPRESSIONS && r.position > 0 && r.position <= MISMATCH_MAX_POSITION && r.sessions >= MISMATCH_MIN_SESSIONS)
    .map((r) => ({ ...r, ctr: r.clicks / r.impressions, expected: expectedCtrForPosition(r.position), engagement: r.engagedSessions / r.sessions }))
    .filter((r) => r.ctr < r.expected * MISMATCH_CTR_RATIO && r.engagement < MISMATCH_MAX_ENGAGEMENT)
    .sort((a, b) => b.impressions - a.impressions || a.page.localeCompare(b.page))
    .map((r) => ({
      source: "content" as const,
      findingType: "content-intent-mismatch" as const,
      stableKeyInput: `content-intent-mismatch:${r.page}`,
      title: `${r.page} sale en posición ${r.position.toFixed(1)} pero casi no se clica (${(r.ctr * 100).toFixed(1)}%) y quien entra se va (${Math.round(r.engagement * 100)}% de interacción): no responde a lo que se busca`,
      detail: { page: r.page, impressions: r.impressions, clicks: r.clicks, avgPosition: r.position, ctr: r.ctr, expectedCtr: r.expected, engagementRate: Math.round(r.engagement * 100) / 100, sessions: r.sessions, demand: "gsc" },
      sourceRefId: r.page,
    }));
}

export const SEASONAL_HISTORY_DAYS = 395;
export const SEASONAL_WINDOW_DAYS = 60;
export const SEASONAL_RATIO = 2;
export const SEASONAL_MIN_IMPRESSIONS = 100;
export const MAX_SEASONAL_FINDINGS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface QueryDay {
  date: Date;
  query: string;
  page: string;
  impressions: number;
}

/**
 * Consultas cuyo tramo de los próximos 60 días, hace un año, tuvo al menos el doble de
 * impresiones que su media de 60 días de ese año. `earliest` es la primera fecha con datos.
 */
export function extractSeasonalFindings(rows: QueryDay[], earliest: Date | null, now: Date): Finding[] {
  if (!earliest || now.getTime() - earliest.getTime() < SEASONAL_HISTORY_DAYS * DAY_MS) return [];
  const yearAgo = now.getTime() - 365 * DAY_MS;
  const winStart = yearAgo;
  const winEnd = yearAgo + SEASONAL_WINDOW_DAYS * DAY_MS;
  const yearStart = yearAgo - 365 * DAY_MS + SEASONAL_WINDOW_DAYS * DAY_MS;
  const byQuery = new Map<string, { window: number; year: number; pages: Map<string, number> }>();
  for (const r of rows) {
    const t = r.date.getTime();
    if (t < yearStart || t >= winEnd) continue;
    const q = byQuery.get(r.query) ?? { window: 0, year: 0, pages: new Map() };
    q.year += r.impressions;
    if (t >= winStart) {
      q.window += r.impressions;
      q.pages.set(r.page, (q.pages.get(r.page) ?? 0) + r.impressions);
    }
    byQuery.set(r.query, q);
  }
  const periods = 365 / SEASONAL_WINDOW_DAYS;
  return [...byQuery]
    .filter(([, q]) => q.window >= SEASONAL_MIN_IMPRESSIONS && q.window >= (q.year / periods) * SEASONAL_RATIO)
    .sort((a, b) => b[1].window - a[1].window || a[0].localeCompare(b[0]))
    .slice(0, MAX_SEASONAL_FINDINGS)
    .map(([query, q]) => {
      const page = [...q.pages].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const ratio = Math.round((q.window / (q.year / periods)) * 10) / 10;
      return {
        source: "content" as const,
        findingType: "content-seasonal" as const,
        stableKeyInput: `content-seasonal:${query}:${new Date(winStart + 365 * DAY_MS).getUTCFullYear()}`,
        title: `«${query}» se multiplicó por ${ratio} en estas fechas el año pasado (${q.window} impresiones en 60 días): preparar la página antes del pico`,
        detail: { query, queries: [query], page, windowImpressions: q.window, yearImpressions: q.year, ratio, demand: "gsc-history" },
        sourceRefId: query,
      };
    });
}
