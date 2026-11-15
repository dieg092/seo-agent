// src/collectors/bingWebmasterCollector.ts
// Fase 6 (§10.6): visibilidad en Bing con la API de Bing Webmaster (clave
// BING_WEBMASTER_API_KEY). Guarda consultas (GetQueryStats), páginas
// (GetPageStats) y rastreo (GetCrawlStats). Bing agrega por semana y devuelve
// unos 6 meses: cada ejecución reescribe lo que llega (upsert por fecha y clave).
// Privacidad igual que en GSC: las URLs privadas se guardan redactadas y se
// registran como incidente; una consulta que es una URL del sitio también.
//
// Métodos verificados contra la API el 2026-11-15. GetKeyword y
// GetRelatedKeywords existen pero para es-ES devuelven 0 o consultas sin relación,
// así que no se usan como volumen (§10.6 pide verificarlo antes de fiarse).
import { prisma } from "../db";
import { getEnv } from "../env";
import { isPrivateUrl, SITE_HOST } from "../privacy/sitePrivacy";
import { redactUrl, requirePrivateUrlKey } from "../privacy/redact";
import { recordPrivateExposure } from "../privacy/privateIncidents";
import { isBrandQuery } from "./brand";

const API = "https://ssl.bing.com/webmaster/api.svc/json/";

export interface BingStatApi {
  Query: string | null;
  Date: string;
  Impressions: number;
  Clicks: number;
  AvgImpressionPosition: number;
  AvgClickPosition: number;
}

export interface BingCrawlApi {
  Date: string;
  CrawledPages: number;
  InIndex: number;
  InLinks: number;
  Code2xx: number;
  Code301: number;
  Code302: number;
  Code4xx: number;
  Code5xx: number;
  BlockedByRobotsTxt: number;
  CrawlErrors: number;
  AllOtherCodes: number;
}

export type BingFetch = (method: string, params: Record<string, string>) => Promise<unknown>;

/** Fecha WCF de la API («/Date(1784246400000)/», con o sin zona) a día UTC. */
export function parseBingDate(value: string): Date | null {
  const m = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//.exec(value ?? "");
  if (!m) return null;
  const d = new Date(Number(m[1]));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const SITE_URL_IN_QUERY = new RegExp(`^(https?://)?(www\\.)?${SITE_HOST.replace(/\./g, "\\.")}(/\\S*)?$`, "i");

/** Si la consulta es una URL del sitio, la URL completa; si no, null. */
export function siteUrlOfQuery(query: string): string | null {
  const q = query.trim();
  if (!SITE_URL_IN_QUERY.test(q)) return null;
  return /^https?:\/\//i.test(q) ? q : `https://${q}`;
}

/** -1 es «sin clics» en la API: se guarda como null. */
function clickPosition(v: number): number | null {
  return typeof v === "number" && v >= 0 ? v : null;
}

async function defaultFetch(method: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams({ ...params, apikey: getEnv("BING_WEBMASTER_API_KEY") });
  const res = await fetch(`${API}${method}?${qs}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Bing ${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { d?: unknown };
  return body.d;
}

export interface BingCollectResult {
  queries: number;
  pages: number;
  crawlDays: number;
  privateSeen: number;
}

export async function collectBingWebmaster(
  deps: { fetch?: BingFetch; privateKey?: string; recordPrivate?: (url: string, source: string) => Promise<unknown> } = {},
): Promise<BingCollectResult> {
  const call = deps.fetch ?? defaultFetch;
  const key = requirePrivateUrlKey(deps.privateKey);
  const recordPrivate = deps.recordPrivate ?? ((url: string, source: string) => recordPrivateExposure(url, source));
  const siteUrl = `https://${SITE_HOST}/`;
  const result: BingCollectResult = { queries: 0, pages: 0, crawlDays: 0, privateSeen: 0 };
  const recorded = new Set<string>();

  const seePrivate = async (url: string, source: string) => {
    if (recorded.has(url)) return;
    recorded.add(url);
    result.privateSeen += 1;
    await recordPrivate(url, source);
  };

  // Consultas. Varias consultas pueden quedar iguales tras redactar: se suman.
  const queries = new Map<string, { date: Date; query: string; impressions: number; clicks: number; posW: number; clickPos: number | null }>();
  for (const r of ((await call("GetQueryStats", { siteUrl })) as BingStatApi[] | null) ?? []) {
    const date = parseBingDate(r.Date);
    if (!date || !r.Query) continue;
    let query = r.Query.trim().toLowerCase();
    const asUrl = siteUrlOfQuery(query);
    if (asUrl && isPrivateUrl(asUrl)) {
      await seePrivate(asUrl, "bing:query");
      query = redactUrl(asUrl, key);
    }
    const k = `${date.toISOString()}\u0000${query}`;
    const cur = queries.get(k) ?? { date, query, impressions: 0, clicks: 0, posW: 0, clickPos: null };
    cur.impressions += r.Impressions;
    cur.clicks += r.Clicks;
    cur.posW += r.AvgImpressionPosition * r.Impressions;
    cur.clickPos = cur.clickPos ?? clickPosition(r.AvgClickPosition);
    queries.set(k, cur);
  }
  for (const q of queries.values()) {
    const data = {
      impressions: q.impressions,
      clicks: q.clicks,
      avgImpressionPosition: q.impressions > 0 ? q.posW / q.impressions : 0,
      avgClickPosition: q.clickPos,
      isBrand: isBrandQuery(q.query),
    };
    await prisma.bingQueryStat.upsert({
      where: { date_query: { date: q.date, query: q.query } },
      create: { date: q.date, query: q.query, ...data },
      update: data,
    });
    result.queries += 1;
  }

  // Páginas.
  const pages = new Map<string, { date: Date; page: string; impressions: number; clicks: number; posW: number; clickPos: number | null }>();
  for (const r of ((await call("GetPageStats", { siteUrl })) as BingStatApi[] | null) ?? []) {
    const date = parseBingDate(r.Date);
    if (!date || !r.Query) continue;
    if (isPrivateUrl(r.Query)) await seePrivate(r.Query, "bing:page");
    const page = redactUrl(r.Query, key);
    const k = `${date.toISOString()}\u0000${page}`;
    const cur = pages.get(k) ?? { date, page, impressions: 0, clicks: 0, posW: 0, clickPos: null };
    cur.impressions += r.Impressions;
    cur.clicks += r.Clicks;
    cur.posW += r.AvgImpressionPosition * r.Impressions;
    cur.clickPos = cur.clickPos ?? clickPosition(r.AvgClickPosition);
    pages.set(k, cur);
  }
  for (const p of pages.values()) {
    const data = {
      impressions: p.impressions,
      clicks: p.clicks,
      avgImpressionPosition: p.impressions > 0 ? p.posW / p.impressions : 0,
      avgClickPosition: p.clickPos,
    };
    await prisma.bingPageStat.upsert({
      where: { date_page: { date: p.date, page: p.page } },
      create: { date: p.date, page: p.page, ...data },
      update: data,
    });
    result.pages += 1;
  }

  // Rastreo (diario).
  for (const r of ((await call("GetCrawlStats", { siteUrl })) as BingCrawlApi[] | null) ?? []) {
    const date = parseBingDate(r.Date);
    if (!date) continue;
    const data = {
      crawledPages: r.CrawledPages ?? 0,
      inIndex: r.InIndex ?? 0,
      inLinks: r.InLinks ?? 0,
      code2xx: r.Code2xx ?? 0,
      code301: r.Code301 ?? 0,
      code302: r.Code302 ?? 0,
      code4xx: r.Code4xx ?? 0,
      code5xx: r.Code5xx ?? 0,
      blockedByRobotsTxt: r.BlockedByRobotsTxt ?? 0,
      crawlErrors: r.CrawlErrors ?? 0,
      allOtherCodes: r.AllOtherCodes ?? 0,
    };
    await prisma.bingCrawlStat.upsert({ where: { date }, create: { date, ...data }, update: data });
    result.crawlDays += 1;
  }
  return result;
}
