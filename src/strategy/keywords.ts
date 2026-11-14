// src/strategy/keywords.ts
// Palabras clave y clústeres (§16.1-16.2). Lógica pura: intención por reglas,
// demanda, agrupación por similitud y los hallazgos de estrategia. La carga
// y los embeddings están en scripts/build-keywords.ts.
import type { Finding } from "../prioritization/types";
import { intentOfPage } from "../prioritization/priority";

export type KeywordIntent = "transactional" | "commercial" | "informational" | "comparison" | "image";

/** Modificadores en castellano (§16.2). El orden importa: el primero que encaja gana. */
const RULES: { intent: KeywordIntent; re: RegExp }[] = [
  { intent: "comparison", re: /\b(vs|versus|o mejor|comparativa|comparar|alternativa(s)?)\b/i },
  { intent: "transactional", re: /\b(precio|precios|cu[aá]nto cuesta|gratis|crear|hacer|plantilla(s)?|comprar|contratar|online|app|descargar|generador|editor)\b/i },
  // Consultas que nombran el producto (conocimiento del producto, §16.2).
  { intent: "commercial", re: /\b(webs? (de )?bodas?|p[aá]gina web (de )?bodas?|bodas? web|invitaci[oó]n(es)? digital(es)?|confirmaci[oó]n de asistencia|rsvp)\b/i },
  { intent: "image", re: /\b(fotos?|im[aá]genes|ejemplos? de dise[nñ]o|png|jpg)\b/i },
  { intent: "commercial", re: /\b(mejor(es)?|top|opiniones|rese[nñ]as|recomendad[oa]s?)\b/i },
];

export function classifyIntent(query: string): KeywordIntent {
  for (const r of RULES) if (r.re.test(query)) return r.intent;
  return "informational";
}

/** Demanda cualitativa por impresiones de GSC en 90 días (sin cifras inventadas: es nuestro dato). */
export function demandOf(impressions90d: number): "low" | "medium" | "high" {
  if (impressions90d >= 300) return "high";
  if (impressions90d >= 50) return "medium";
  return "low";
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export const CLUSTER_SIMILARITY = 0.8;

/**
 * Agrupación voraz y determinista: por impresiones descendentes, cada consulta
 * entra en el primer clúster cuyo centro (su consulta de más impresiones) se
 * le parece ≥ 0,8; si no, abre uno nuevo. Devuelve el índice del centro de
 * cada consulta.
 */
export function clusterQueries(items: { query: string; impressions: number; embedding: number[] }[]): Map<string, string> {
  const sorted = [...items].sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
  const centers: { query: string; embedding: number[] }[] = [];
  const assignment = new Map<string, string>();
  for (const item of sorted) {
    if (item.embedding.length === 0) continue;
    const center = centers.find((c) => cosine(c.embedding, item.embedding) >= CLUSTER_SIMILARITY);
    if (center) assignment.set(item.query, center.query);
    else {
      centers.push({ query: item.query, embedding: item.embedding });
      assignment.set(item.query, item.query);
    }
  }
  return assignment;
}

export interface QueryPageRow {
  query: string;
  page: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface KeywordRow {
  query: string;
  intent: KeywordIntent;
  impressions90d: number;
  clicks90d: number;
  avgPosition: number;
  bestPage: string | null;
  bestPagePosition: number | null;
  demand: "low" | "medium" | "high";
}

/** Agrega las filas consulta-página en una fila por consulta; la mejor página es la de mejor posición media. */
export function buildKeywordRows(rows: QueryPageRow[]): KeywordRow[] {
  const byQuery = new Map<string, Map<string, { impressions: number; clicks: number; posW: number }>>();
  for (const r of rows) {
    const pages = byQuery.get(r.query) ?? new Map();
    const cur = pages.get(r.page) ?? { impressions: 0, clicks: 0, posW: 0 };
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    cur.posW += r.position * r.impressions;
    pages.set(r.page, cur);
    byQuery.set(r.query, pages);
  }
  const out: KeywordRow[] = [];
  for (const [query, pages] of byQuery) {
    let impressions = 0;
    let clicks = 0;
    let posW = 0;
    let best: { page: string; pos: number } | null = null;
    for (const [page, s] of pages) {
      impressions += s.impressions;
      clicks += s.clicks;
      posW += s.posW;
      const pos = s.impressions > 0 ? s.posW / s.impressions : 999;
      if (!best || pos < best.pos) best = { page, pos };
    }
    out.push({
      query,
      intent: classifyIntent(query),
      impressions90d: impressions,
      clicks90d: clicks,
      avgPosition: impressions > 0 ? posW / impressions : 0,
      bestPage: best?.page ?? null,
      bestPagePosition: best ? best.pos : null,
      demand: demandOf(impressions),
    });
  }
  return out.sort((a, b) => b.impressions90d - a.impressions90d || a.query.localeCompare(b.query));
}

export interface ClusterRow {
  label: string;
  intent: KeywordIntent;
  mainPage: string | null;
  mainPagePosition: number | null;
  hasProductPage: boolean;
  queryCount: number;
  impressions90d: number;
  clicks90d: number;
  queries: string[];
}

/** Resume cada clúster: intención dominante, página principal (mejor posición, desempate comercial) y si tiene página `product` en el top 20. */
export function summarizeClusters(keywords: KeywordRow[], assignment: Map<string, string>): ClusterRow[] {
  const groups = new Map<string, KeywordRow[]>();
  for (const k of keywords) {
    const center = assignment.get(k.query);
    if (!center) continue;
    groups.set(center, [...(groups.get(center) ?? []), k]);
  }
  const out: ClusterRow[] = [];
  for (const [label, ks] of groups) {
    const byIntent = new Map<KeywordIntent, number>();
    for (const k of ks) byIntent.set(k.intent, (byIntent.get(k.intent) ?? 0) + k.impressions90d);
    const intent = [...byIntent].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const pages = ks.filter((k) => k.bestPage && k.bestPagePosition !== null);
    // Página principal: la que más impresiones recoge en el clúster (desempate:
    // la comercial), con su posición media ponderada por impresiones. Una sola
    // consulta en el puesto 1 no tapa un hueco.
    const byPage = new Map<string, { impressions: number; posW: number }>();
    for (const k of pages) {
      const cur = byPage.get(k.bestPage!) ?? { impressions: 0, posW: 0 };
      cur.impressions += k.impressions90d;
      cur.posW += k.bestPagePosition! * k.impressions90d;
      byPage.set(k.bestPage!, cur);
    }
    const isProduct = (p: string) => Number(intentOfPage(p) === "product");
    const main = [...byPage].sort((a, b) => b[1].impressions - a[1].impressions || isProduct(b[0]) - isProduct(a[0]) || a[0].localeCompare(b[0]))[0];
    out.push({
      label,
      intent,
      mainPage: main?.[0] ?? null,
      mainPagePosition: main && main[1].impressions > 0 ? main[1].posW / main[1].impressions : null,
      hasProductPage: pages.some((k) => intentOfPage(k.bestPage) === "product" && (k.bestPagePosition ?? 999) <= 20),
      queryCount: ks.length,
      impressions90d: ks.reduce((a, k) => a + k.impressions90d, 0),
      clicks90d: ks.reduce((a, k) => a + k.clicks90d, 0),
      queries: ks.map((k) => k.query),
    });
  }
  return out.sort((a, b) => b.impressions90d - a.impressions90d || a.label.localeCompare(b.label));
}

export const COMMERCIAL_MIN_IMPRESSIONS = 100;
export const GAP_MIN_IMPRESSIONS = 100;
export const GAP_POSITION = 20;

/**
 * - `commercial-page-missing`: clúster transaccional o comercial con demanda
 *   (≥ 100 impresiones en 90 días) y sin página `product` en el top 20.
 * - `topic-cluster-gap`: clúster con demanda cuya mejor página está fuera del
 *   top 20 (no hay página adecuada).
 */
export function extractStrategyFindings(clusters: (ClusterRow & { id: string })[]): Finding[] {
  const findings: Finding[] = [];
  for (const c of clusters) {
    const commercial = c.intent === "transactional" || c.intent === "commercial";
    if (commercial && c.impressions90d >= COMMERCIAL_MIN_IMPRESSIONS && !c.hasProductPage) {
      findings.push({
        source: "strategy",
        findingType: "commercial-page-missing",
        stableKeyInput: `commercial-page-missing:${c.label}`,
        title: `Búsquedas de intención ${c.intent === "transactional" ? "transaccional" : "comercial"} sobre «${c.label}» (${c.impressions90d} impresiones en 90 días) sin página de producto en el top 20`,
        detail: { cluster: c.label, intent: c.intent, impressions90d: c.impressions90d, queries: c.queries.slice(0, 10), page: c.mainPage, demand: "gsc" },
        sourceRefId: c.id,
      });
    } else if (c.impressions90d >= GAP_MIN_IMPRESSIONS && (c.mainPagePosition === null || c.mainPagePosition > GAP_POSITION)) {
      findings.push({
        source: "strategy",
        findingType: "topic-cluster-gap",
        stableKeyInput: `topic-cluster-gap:${c.label}`,
        title: `El tema «${c.label}» tiene ${c.impressions90d} impresiones en 90 días y su página principal está fuera del top 20 (posición ${c.mainPagePosition?.toFixed(1) ?? "-"})`,
        detail: { cluster: c.label, intent: c.intent, impressions90d: c.impressions90d, queries: c.queries.slice(0, 10), page: c.mainPage, position: c.mainPagePosition },
        sourceRefId: c.id,
      });
    }
  }
  return findings;
}
