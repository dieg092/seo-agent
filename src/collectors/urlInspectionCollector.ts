// src/collectors/urlInspectionCollector.ts
// Inspección de URLs (§10.2 de la spec). Cada día se inspecciona, por este orden:
//   1. tracked:    la última inspección no fue PASS;
//   2. recent:     lastmod del sitemap en los últimos 14 días;
//   3. commercial: páginas comerciales (invitacion-digital-boda, precios, plantillas,
//                  funcionalidades, herramientas) y la raíz;
//   4. orphan:     URLs con impresiones en 28 días que no están en el sitemap;
//   5. sweep:      el resto del sitemap, solo los domingos, empezando por la que lleva
//                  más tiempo sin inspeccionar.
// Presupuesto: 1.800 de las 2.000 llamadas diarias y 500 de las 600 por minuto.
// Nunca se inspecciona una URL privada. Un error en una URL no corta la tanda; una cuota
// agotada (429 / RESOURCE_EXHAUSTED) para y deja skippedForBudget. Lo que no se
// inspecciona no se guarda: una URL sin inspeccionar nunca cuenta como desindexada.
import * as cheerio from "cheerio";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getEnv } from "../env";
import { recordAlert } from "../alerts/recordAlert";
import { inspectUrl, type InspectionResult } from "../google/urlInspectionClient";
import { SITE_HOST, isPrivateUrl, normalizeUrl } from "../privacy/sitePrivacy";
import { redactUrl, requirePrivateUrlKey } from "../privacy/redact";

export const DAILY_INSPECTION_BUDGET = 1_800;
export const INSPECTIONS_PER_MINUTE = 500;
export const RECENT_DAYS = 14;
export const ORPHAN_LOOKBACK_DAYS = 28;
export const COMMERCIAL_FIRST_SEGMENTS: readonly string[] = [
  "invitacion-digital-boda",
  "precios",
  "plantillas",
  "funcionalidades",
  "herramientas",
];

export type InspectionReason = "tracked" | "recent" | "commercial" | "orphan" | "sweep";

const DAY_MS = 24 * 60 * 60 * 1000;

/** El barrido completo del sitemap se hace los domingos (en UTC, como el cron). */
export function isSweepDay(today: Date): boolean {
  return today.getUTCDay() === 0;
}

// Normaliza sin lanzar: una URL ilegible se descarta.
function safeNormalize(url: string): string | null {
  try {
    return normalizeUrl(url);
  } catch {
    return null;
  }
}

function safeIsPrivate(url: string): boolean {
  try {
    return isPrivateUrl(url);
  } catch {
    return true;
  }
}

function isCommercial(normalized: string): boolean {
  const path = new URL(normalized).pathname;
  if (path === "/") return true;
  const first = path.split("/")[1] ?? "";
  return COMMERCIAL_FIRST_SEGMENTS.includes(first);
}

/**
 * Elige qué URLs inspeccionar y por qué, en orden de prioridad y sin repetir.
 * `lastByUrl` va indexado por `normalizeUrl(url)`; las URLs privadas o ilegibles se descartan.
 */
export function selectForInspection(p: {
  sitemap: { url: string; lastmod: Date | null }[];
  orphanWithImpressions: string[];
  lastByUrl: Map<string, { verdict: string | null; inspectedAt: Date }>;
  today: Date;
  fullSweep: boolean;
  budget: number;
}): { url: string; inSitemap: boolean; reason: string }[] {
  // Universo de candidatas: el sitemap y las URLs con impresiones, públicas y sin repetir.
  const sitemap = new Map<string, { url: string; lastmod: Date | null }>();
  for (const entry of p.sitemap) {
    const key = safeNormalize(entry.url);
    if (!key || safeIsPrivate(entry.url) || sitemap.has(key)) continue;
    sitemap.set(key, entry);
  }
  const orphans = new Map<string, string>();
  for (const url of p.orphanWithImpressions) {
    const key = safeNormalize(url);
    if (!key || safeIsPrivate(url) || sitemap.has(key) || orphans.has(key)) continue;
    orphans.set(key, url);
  }

  const chosen = new Set<string>();
  const out: { url: string; inSitemap: boolean; reason: InspectionReason }[] = [];
  const add = (keys: string[], reason: InspectionReason) => {
    for (const key of keys) {
      if (chosen.has(key)) continue;
      chosen.add(key);
      const inSitemap = sitemap.has(key);
      out.push({ url: inSitemap ? sitemap.get(key)!.url : orphans.get(key)!, inSitemap, reason });
    }
  };
  const lastTime = (key: string) => p.lastByUrl.get(key)?.inspectedAt.getTime() ?? -Infinity;
  const universe = [...sitemap.keys(), ...orphans.keys()];

  // 1. tracked: la última inspección no fue PASS (la más antigua primero).
  add(
    universe
      .filter((k) => {
        const last = p.lastByUrl.get(k);
        return last !== undefined && last.verdict !== "PASS";
      })
      .sort((a, b) => lastTime(a) - lastTime(b)),
    "tracked"
  );

  // 2. recent: lastmod en los últimos 14 días (la más reciente primero).
  const recentFrom = p.today.getTime() - RECENT_DAYS * DAY_MS;
  add(
    [...sitemap.entries()]
      .filter(([, e]) => e.lastmod !== null && e.lastmod.getTime() >= recentFrom)
      .sort(([, a], [, b]) => b.lastmod!.getTime() - a.lastmod!.getTime())
      .map(([k]) => k),
    "recent"
  );

  // 3. commercial, en el orden del sitemap.
  add([...sitemap.keys()].filter(isCommercial), "commercial");

  // 4. orphan: con impresiones y fuera del sitemap.
  add([...orphans.keys()], "orphan");

  // 5. sweep: el resto del sitemap, solo con barrido completo; las nunca inspeccionadas
  //    primero y luego las que llevan más tiempo sin inspeccionar.
  if (p.fullSweep) {
    add(
      [...sitemap.keys()].filter((k) => !chosen.has(k)).sort((a, b) => lastTime(a) - lastTime(b)),
      "sweep"
    );
  }

  return out.slice(0, Math.max(0, p.budget));
}

/** Cuota agotada: 429 o RESOURCE_EXHAUSTED en cualquiera de las formas que usa googleapis. */
export function isQuotaExhausted(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    response?: { status?: unknown; data?: unknown };
    errors?: { reason?: unknown }[];
  } | null;
  if (!e) return false;
  if (String(e.code) === "429" || e.status === 429 || e.response?.status === 429) return true;
  const text = [e.status, e.message, JSON.stringify(e.response?.data ?? null)].map(String).join(" ");
  if (/RESOURCE_EXHAUSTED|rateLimitExceeded|quotaExceeded/i.test(text)) return true;
  return (e.errors ?? []).some((x) => /rateLimitExceeded|quotaExceeded/i.test(String(x?.reason)));
}

// --- Fuentes por defecto ---

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`No se pudo descargar ${url}: ${response.status}`);
  return response.text();
}

/** Lee el sitemap publicado (y sus hijos si es un índice) con su lastmod. */
export async function fetchSitemapEntries(
  deps: { fetchXml?: (url: string) => Promise<string>; baseUrl?: string } = {}
): Promise<{ url: string; lastmod: Date | null }[]> {
  const fetchXml = deps.fetchXml ?? fetchText;
  const baseUrl = (deps.baseUrl ?? getEnv("SITE_BASE_URL")).replace(/\/+$/, "");
  const entries: { url: string; lastmod: Date | null }[] = [];
  const visited = new Set<string>();

  const visit = async (url: string, depth: number) => {
    if (visited.has(url) || depth > 2) return;
    visited.add(url);
    const $ = cheerio.load(await fetchXml(url), { xmlMode: true });
    // Índice de sitemaps: se siguen solo los hijos de nuestro dominio.
    for (const el of $("sitemapindex > sitemap").toArray()) {
      const loc = $(el).find("loc").first().text().trim();
      const host = loc ? safeHost(loc) : null;
      if (host === SITE_HOST) await visit(loc, depth + 1);
    }
    for (const el of $("urlset > url").toArray()) {
      const loc = $(el).find("loc").first().text().trim();
      if (!loc) continue;
      const raw = $(el).find("lastmod").first().text().trim();
      const lastmod = raw ? new Date(raw) : null;
      entries.push({ url: loc, lastmod: lastmod && !Number.isNaN(lastmod.getTime()) ? lastmod : null });
    }
  };

  await visit(`${baseUrl}/sitemap.xml`, 0);
  return entries;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Páginas con impresiones en los últimos 28 días (las redactadas son privadas y se descartan luego). */
async function defaultOrphans(today: Date): Promise<string[]> {
  const since = new Date(today.getTime() - ORPHAN_LOOKBACK_DAYS * DAY_MS);
  const [daily, snapshot] = await Promise.all([
    prisma.searchConsolePageDaily.findMany({
      where: { type: "web", date: { gte: since }, impressions: { gt: 0 } },
      select: { page: true },
      distinct: ["page"],
    }),
    prisma.searchConsoleSnapshot.findMany({
      where: { date: { gte: since }, impressions: { gt: 0 } },
      select: { page: true },
      distinct: ["page"],
    }),
  ]);
  return [...daily.map((r) => r.page), ...snapshot.map((r) => r.page)];
}

/** Última inspección correcta (sin error) de cada URL, indexada por URL normalizada. */
async function loadLastByUrl(urls: string[]): Promise<Map<string, { verdict: string | null; inspectedAt: Date }>> {
  const map = new Map<string, { verdict: string | null; inspectedAt: Date }>();
  if (urls.length === 0) return map;
  const rows = await prisma.urlInspection.findMany({
    where: { url: { in: urls }, error: null },
    orderBy: [{ url: "asc" }, { inspectedAt: "desc" }],
    distinct: ["url"],
    select: { url: true, verdict: true, inspectedAt: true },
  });
  for (const r of rows) map.set(r.url, { verdict: r.verdict, inspectedAt: r.inspectedAt });
  return map;
}

// Las canónicas que devuelve Google también se redactan si fueran privadas.
function redactOptional(url: string | undefined, key: string): string | null {
  if (!url) return null;
  try {
    return redactUrl(url, key);
  } catch {
    return null;
  }
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function collectUrlInspections(
  deps: {
    inspect?: typeof inspectUrl;
    sitemap?: () => Promise<{ url: string; lastmod: Date | null }[]>;
    orphans?: () => Promise<string[]>;
    today?: Date;
    budget?: number;
    perMinute?: number;
    sleep?: (ms: number) => Promise<void>;
    alert?: typeof recordAlert;
  } = {}
): Promise<{ inspected: number; failed: number; skippedForBudget: number }> {
  // Sin clave no se escribe nada: nunca se guarda una URL privada en claro.
  const key = requirePrivateUrlKey();
  const inspect = deps.inspect ?? inspectUrl;
  const today = deps.today ?? new Date();
  const budget = deps.budget ?? DAILY_INSPECTION_BUDGET;
  const perMinute = deps.perMinute ?? INSPECTIONS_PER_MINUTE;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alert = deps.alert ?? recordAlert;

  const sitemap = await (deps.sitemap ?? (() => fetchSitemapEntries()))();
  const orphans = await (deps.orphans ?? (() => defaultOrphans(today)))();

  const candidates = [...sitemap.map((e) => e.url), ...orphans]
    .filter((u) => !safeIsPrivate(u))
    .map(safeNormalize)
    .filter((u): u is string => u !== null);
  const lastByUrl = await loadLastByUrl([...new Set(candidates)]);

  // Lo ya gastado en las últimas 24 h (p. ej. si el workflow se relanza) sale del presupuesto.
  const usedLastDay = await prisma.urlInspection.count({
    where: { inspectedAt: { gt: new Date(today.getTime() - DAY_MS), lte: today } },
  });
  const remaining = Math.max(0, budget - usedLastDay);

  const all = selectForInspection({
    sitemap,
    orphanWithImpressions: orphans,
    lastByUrl,
    today,
    fullSweep: isSweepDay(today),
    budget: Number.POSITIVE_INFINITY,
  });
  const queue = all.slice(0, remaining);

  const result = { inspected: 0, failed: 0, skippedForBudget: all.length - queue.length };
  const failures: string[] = [];
  let quotaStop: string | null = null;
  const intervalMs = perMinute > 0 ? Math.ceil(60_000 / perMinute) : 0;

  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (i > 0 && intervalMs > 0) await sleep(intervalMs);

    const base = { url: redactUrl(item.url, key), inspectedAt: today, inSitemap: item.inSitemap, reason: item.reason };
    let data: InspectionResult;
    try {
      data = await inspect(item.url);
    } catch (error) {
      if (isQuotaExhausted(error)) {
        // Esta y las que quedan no se inspeccionan ni se guardan.
        result.skippedForBudget += queue.length - i;
        quotaStop = (error as Error)?.message ?? String(error);
        break;
      }
      const message = ((error as Error)?.message ?? String(error)).slice(0, 1000);
      await prisma.urlInspection.create({ data: { ...base, error: message } });
      result.failed += 1;
      failures.push(`${base.url}: ${message}`);
      continue;
    }

    await prisma.urlInspection.create({
      data: {
        ...base,
        verdict: data.verdict ?? null,
        coverageState: data.coverageState ?? null,
        indexingState: data.indexingState ?? null,
        robotsTxtState: data.robotsTxtState ?? null,
        pageFetchState: data.pageFetchState ?? null,
        lastCrawlTime: parseDate(data.lastCrawlTime),
        googleCanonical: redactOptional(data.googleCanonical, key),
        userCanonical: redactOptional(data.userCanonical, key),
        crawledAs: data.crawledAs ?? null,
        richResultsVerdict: data.richResultsVerdict ?? null,
        richResultsItems:
          data.richResultsItems === undefined ? undefined : (data.richResultsItems as Prisma.InputJsonValue),
      },
    });
    result.inspected += 1;
  }

  if (quotaStop !== null) {
    await alert({
      type: "url-inspection-quota",
      subject: "URL Inspection: cuota agotada",
      body:
        `Se ha parado tras ${result.inspected} inspecciones; ${result.skippedForBudget} URLs quedan sin inspeccionar ` +
        `(no cuentan como desindexadas). Error: ${quotaStop.slice(0, 300)}`,
    });
  }
  if (failures.length > 0) {
    const more = failures.length > 20 ? `\n… y ${failures.length - 20} más` : "";
    await alert({
      type: "url-inspection-error",
      subject: `URL Inspection: ${failures.length} URL(s) con error`,
      body: failures.slice(0, 20).join("\n") + more,
    });
  }

  return result;
}
