// src/detectors/annexB.ts
// Detectores del Anexo B que faltaban (fase 2c): indexación, sitemaps de GSC,
// privacidad, rastreo propio, visibilidad, calidad de datos y embudo.
// Lógica pura: reciben filas ya leídas y devuelven hallazgos. La carga de
// datos está en prioritize.ts (computeCurrentFindings). Cada hallazgo pasa
// después por la máquina de estados (§6), así que no hace falta exigir aquí
// varias confirmaciones: un hallazgo no crítico se abre a la segunda.
import type { Finding } from "../prioritization/types";
import { intentOfPage } from "../prioritization/priority";

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Indexación (UrlInspection) ─────────────────────────────────────────────

export interface InspectionRow {
  id: string;
  url: string;
  inspectedAt: Date;
  inSitemap: boolean;
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  richResultsVerdict: string | null;
  richResultsItems: unknown;
  error: string | null;
}

/** Normaliza una URL para comparar canónicas: sin barra final, sin fragmento y en minúsculas el host. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/** Las dos últimas inspecciones válidas (sin error) de cada URL, la más reciente primero. */
export function latestInspections(rows: InspectionRow[]): Map<string, InspectionRow[]> {
  const byUrl = new Map<string, InspectionRow[]>();
  for (const row of rows) {
    if (row.error) continue;
    const list = byUrl.get(row.url) ?? [];
    list.push(row);
    byUrl.set(row.url, list);
  }
  for (const [url, list] of byUrl) {
    list.sort((a, b) => b.inspectedAt.getTime() - a.inspectedAt.getTime());
    byUrl.set(url, list.slice(0, 2));
  }
  return byUrl;
}

// Tipos de resultado enriquecido fuera del alcance (R-B6): Google ya no los muestra.
const RICH_RESULTS_IGNORED = /faq|howto/i;

function richResultsTypes(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>).richResultType : null))
    .filter((t): t is string => typeof t === "string");
}

export function extractIndexationFindings(
  rows: InspectionRow[],
  impressions28dByUrl: Map<string, number>,
  now: Date,
): Finding[] {
  const findings: Finding[] = [];
  const firstInspectedAt = new Map<string, Date>();
  for (const row of rows) {
    const cur = firstInspectedAt.get(row.url);
    if (!cur || row.inspectedAt < cur) firstInspectedAt.set(row.url, row.inspectedAt);
  }
  for (const [url, list] of latestInspections(rows)) {
    const [last, prev] = list;
    const ref = last.id;

    if (prev && prev.verdict === "PASS" && last.verdict !== "PASS" && (impressions28dByUrl.get(url) ?? 0) > 0) {
      findings.push({
        source: "indexation",
        findingType: "index-dropped",
        stableKeyInput: `index-dropped:${url}`,
        title: `Google ha dejado de indexar ${url} (${last.coverageState ?? last.verdict ?? "sin estado"})`,
        detail: { url, coverageState: last.coverageState, verdict: last.verdict },
        sourceRefId: ref,
      });
    }

    // Sin fecha de publicación, la primera inspección de la URL hace de
    // sustituto: se exige que Google la conozca desde hace más de 14 días.
    const firstSeen = firstInspectedAt.get(url) ?? last.inspectedAt;
    if (
      last.inSitemap &&
      list.length === 2 &&
      list.every((r) => r.verdict !== "PASS") &&
      now.getTime() - firstSeen.getTime() > 14 * DAY_MS
    ) {
      findings.push({
        source: "indexation",
        findingType: "index-not-indexed",
        stableKeyInput: `index-not-indexed:${url}`,
        title: `${url} está en el sitemap pero Google no la indexa (${last.coverageState ?? "sin estado"})`,
        detail: { url, coverageState: last.coverageState },
        sourceRefId: ref,
      });
    }

    if (last.googleCanonical && last.userCanonical && normalizeUrl(last.googleCanonical) !== normalizeUrl(last.userCanonical)) {
      findings.push({
        source: "indexation",
        findingType: "index-canonical-mismatch",
        stableKeyInput: `index-canonical-mismatch:${url}`,
        title: `Google elige otra canónica para ${url}: ${last.googleCanonical}`,
        detail: { url, googleCanonical: last.googleCanonical, userCanonical: last.userCanonical },
        sourceRefId: ref,
      });
    }

    // *_UNSPECIFIED es «Google no conoce la URL»: eso es index-not-indexed, no un bloqueo.
    const fetchFailed =
      last.pageFetchState !== null && last.pageFetchState !== "SUCCESSFUL" && !last.pageFetchState.endsWith("UNSPECIFIED");
    const blocked =
      last.robotsTxtState === "DISALLOWED" || (last.indexingState ?? "").startsWith("BLOCKED") || fetchFailed;
    if (last.inSitemap && blocked) {
      findings.push({
        source: "indexation",
        findingType: "index-blocked",
        stableKeyInput: `index-blocked:${url}`,
        title: `${url} está en el sitemap pero Google no puede indexarla (robots: ${last.robotsTxtState ?? "-"}, indexación: ${last.indexingState ?? "-"}, descarga: ${last.pageFetchState ?? "-"})`,
        detail: { url, robotsTxtState: last.robotsTxtState, indexingState: last.indexingState, pageFetchState: last.pageFetchState },
        sourceRefId: ref,
      });
    }

    if (last.richResultsVerdict === "FAIL") {
      const types = richResultsTypes(last.richResultsItems);
      const inScope = types.length === 0 ? [] : types.filter((t) => !RICH_RESULTS_IGNORED.test(t));
      if (types.length === 0 || inScope.length > 0) {
        findings.push({
          source: "indexation",
          findingType: "rich-results-error",
          stableKeyInput: `rich-results-error:${url}`,
          title: `Errores de resultados enriquecidos en ${url}${inScope.length ? ` (${inScope.join(", ")})` : ""}`,
          detail: { url, types: inScope },
          sourceRefId: ref,
        });
      }
    }
  }
  return findings;
}

// ─── Sitemaps según GSC ─────────────────────────────────────────────────────

export interface SitemapStatusRow {
  id: string;
  path: string;
  checkedAt: Date;
  lastDownloaded: Date | null;
  isPending: boolean;
  errors: number;
}

export function extractGscSitemapFindings(rows: SitemapStatusRow[], now: Date): Finding[] {
  const latest = new Map<string, SitemapStatusRow>();
  const firstPending = new Map<string, Date>();
  for (const row of [...rows].sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime())) {
    latest.set(row.path, row);
    if (row.isPending) {
      if (!firstPending.has(row.path)) firstPending.set(row.path, row.checkedAt);
    } else {
      firstPending.delete(row.path);
    }
  }
  const findings: Finding[] = [];
  for (const [path, row] of latest) {
    const reasons: string[] = [];
    if (row.errors > 0) reasons.push(`${row.errors} errores`);
    const pendingSince = firstPending.get(path);
    if (row.isPending && pendingSince && now.getTime() - pendingSince.getTime() > 7 * DAY_MS) reasons.push("pendiente más de 7 días");
    if (row.lastDownloaded && now.getTime() - row.lastDownloaded.getTime() > 14 * DAY_MS) reasons.push("Google no lo descarga desde hace más de 14 días");
    if (reasons.length === 0) continue;
    findings.push({
      source: "sitemap",
      findingType: "sitemap-gsc-error",
      stableKeyInput: `sitemap-gsc-error:${path}`,
      title: `Search Console da problemas con el sitemap ${path}: ${reasons.join(", ")}`,
      detail: { path, errors: row.errors, isPending: row.isPending, lastDownloaded: row.lastDownloaded },
      sourceRefId: row.id,
    });
  }
  return findings;
}

// ─── Privacidad ─────────────────────────────────────────────────────────────

export interface PrivateIncidentRow {
  id: string;
  urlHmac: string;
  sources: string[];
  resolvedAt: Date | null;
}

/** Nunca lleva la URL: solo el HMAC (la URL va cifrada en PrivateIncident). */
export function extractPrivacyFindings(rows: PrivateIncidentRow[]): Finding[] {
  return rows
    .filter((r) => r.resolvedAt === null)
    .map((r) => ({
      source: "privacy" as const,
      findingType: "private-page-exposed" as const,
      stableKeyInput: `private-page-exposed:${r.urlHmac}`,
      title: `Una página privada aparece expuesta (${r.sources.join(", ")}). Ver PrivateIncident ${r.urlHmac.slice(0, 12)}`,
      detail: { urlHmac: r.urlHmac, sources: r.sources },
      sourceRefId: r.id,
    }));
}

// ─── Rastreo propio (CrawlPage, última pasada) ──────────────────────────────

export interface CrawlRow {
  id: string;
  url: string;
  inSitemap: boolean;
  depth: number;
  status: number | null;
  redirectTo: string | null;
  contentType: string | null;
  canonical: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  title: string | null;
  h1: string[];
  internalLinks: string[];
}

const SITE_NAME = /^\s*miwebdeboda(\.com)?\s*$/i;
export const MAX_DEPTH = 4;

function isHtmlOk(row: CrawlRow): boolean {
  return row.status === 200 && (row.contentType ?? "text/html").includes("html");
}

function isNoindex(row: CrawlRow): boolean {
  return /noindex/i.test(row.metaRobots ?? "") || /noindex/i.test(row.xRobotsTag ?? "");
}

/**
 * noindex puesto a propósito en páginas con intent `product`: el editor
 * (`/tool`, decisión SEO 2026-11-14), las demos con datos ficticios y
 * cualquier variante con query (su canónica es otra URL).
 */
export const INTENTIONAL_NOINDEX: RegExp[] = [/^\/tool\/?$/, /^\/plantillas\/[^/]+\/demo\/?$/];

function isIntentionalNoindex(row: CrawlRow): boolean {
  try {
    const u = new URL(row.url);
    if (u.search) return true;
    if (row.canonical && normalizeUrl(row.canonical) !== normalizeUrl(row.url)) return true;
    return INTENTIONAL_NOINDEX.some((re) => re.test(u.pathname));
  } catch {
    return false;
  }
}

export function extractCrawlFindings(rows: CrawlRow[]): Finding[] {
  const findings: Finding[] = [];
  const byUrl = new Map(rows.map((r) => [normalizeUrl(r.url), r]));
  const indexable = rows.filter((r) => isHtmlOk(r) && !isNoindex(r));

  // Enlaces de entrada desde otras páginas rastreadas.
  const inlinks = new Map<string, number>();
  for (const row of rows) {
    for (const link of new Set(row.internalLinks.map(normalizeUrl))) {
      if (link === normalizeUrl(row.url)) continue;
      inlinks.set(link, (inlinks.get(link) ?? 0) + 1);
    }
  }

  // Títulos repetidos entre páginas indexables.
  const byTitle = new Map<string, string[]>();
  for (const row of indexable) {
    const t = (row.title ?? "").trim();
    if (!t) continue;
    byTitle.set(t, [...(byTitle.get(t) ?? []), row.url]);
  }
  for (const [title, urls] of byTitle) {
    if (urls.length < 2) continue;
    const sorted = [...urls].sort();
    findings.push({
      source: "crawl",
      findingType: "meta-duplicate",
      stableKeyInput: `meta-duplicate:${title}`,
      title: `El mismo title en ${sorted.length} páginas: «${title}»`,
      detail: { title, urls: sorted, page: sorted[0] },
      sourceRefId: byUrl.get(normalizeUrl(sorted[0]))?.id ?? sorted[0],
    });
  }

  for (const row of rows) {
    const url = row.url;
    if (isHtmlOk(row) && !isNoindex(row)) {
      const title = (row.title ?? "").trim();
      if (!title || SITE_NAME.test(title)) {
        findings.push({
          source: "crawl",
          findingType: "meta-missing",
          stableKeyInput: `meta-missing:${url}`,
          title: `${url} no tiene un title propio`,
          detail: { url, title },
          sourceRefId: row.id,
        });
      }
      if (row.h1.length !== 1) {
        findings.push({
          source: "crawl",
          findingType: "h1-missing-or-multiple",
          stableKeyInput: `h1-missing-or-multiple:${url}`,
          title: `${url} tiene ${row.h1.length} h1`,
          detail: { url, h1: row.h1 },
          sourceRefId: row.id,
        });
      }
      if (row.inSitemap && normalizeUrl(url) !== normalizeUrl(new URL("/", url).href) && (inlinks.get(normalizeUrl(url)) ?? 0) === 0) {
        findings.push({
          source: "crawl",
          findingType: "orphan-page",
          stableKeyInput: `orphan-page:${url}`,
          title: `${url} está en el sitemap pero ninguna página enlaza a ella`,
          detail: { url },
          sourceRefId: row.id,
        });
      }
      if (row.depth > MAX_DEPTH && intentOfPage(url) !== "other") {
        findings.push({
          source: "crawl",
          findingType: "deep-page",
          stableKeyInput: `deep-page:${url}`,
          title: `${url} está a ${row.depth} clics de la home`,
          detail: { url, depth: row.depth },
          sourceRefId: row.id,
        });
      }
    }

    if (row.status === 200 && isNoindex(row) && intentOfPage(url) === "product" && !isIntentionalNoindex(row)) {
      findings.push({
        source: "crawl",
        findingType: "noindex-commercial",
        stableKeyInput: `noindex-commercial:${url}`,
        title: `La página comercial ${url} sirve noindex`,
        detail: { url, metaRobots: row.metaRobots, xRobotsTag: row.xRobotsTag },
        sourceRefId: row.id,
      });
    }

    if (row.inSitemap && (row.status === 404 || row.status === 410)) {
      findings.push({
        source: "crawl",
        findingType: "sitemap-dead-url",
        stableKeyInput: `sitemap-dead-url:${url}`,
        title: `${url} está en el sitemap y devuelve ${row.status}`,
        detail: { url, status: row.status },
        sourceRefId: row.id,
      });
    }

    for (const link of new Set(row.internalLinks)) {
      const target = byUrl.get(normalizeUrl(link));
      if (!target || target.status === null) continue;
      if (target.status >= 400) {
        findings.push({
          source: "crawl",
          findingType: "broken-internal-link",
          stableKeyInput: `broken-internal-link:${url}->${normalizeUrl(link)}`,
          title: `${url} enlaza a ${link}, que devuelve ${target.status}`,
          detail: { url, target: link, status: target.status },
          sourceRefId: row.id,
        });
      } else if (target.status >= 300 && target.status < 400 && target.redirectTo) {
        findings.push({
          source: "crawl",
          findingType: "link-to-redirect",
          stableKeyInput: `link-to-redirect:${url}->${normalizeUrl(link)}`,
          title: `${url} enlaza a ${link}, que redirige a ${target.redirectTo}`,
          detail: { url, target: link, redirectTo: target.redirectTo },
          sourceRefId: row.id,
        });
      }
    }
  }
  return findings;
}

// ─── Visibilidad (SearchConsolePageDaily / SegmentDaily) ────────────────────

export interface PageTypeRow {
  page: string;
  type: string;
  clicks: number;
  impressions: number;
}

export const VISIBILITY_MIN_BASE = 100;
/** Hasta tener grupo de control (modo high, §15.2), una banda fija. */
export const VISIBILITY_DROP = 0.3;

function sumBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(key(r), (out.get(key(r)) ?? 0) + val(r));
  return out;
}

export function extractVisibilityFindings(recent: PageTypeRow[], prior: PageTypeRow[]): Finding[] {
  const findings: Finding[] = [];
  const web = (rows: PageTypeRow[]) => rows.filter((r) => r.type === "web");
  const recentImpr = sumBy(web(recent), (r) => r.page, (r) => r.impressions);
  const priorImpr = sumBy(web(prior), (r) => r.page, (r) => r.impressions);
  for (const [page, before] of priorImpr) {
    if (before < VISIBILITY_MIN_BASE) continue;
    const after = recentImpr.get(page) ?? 0;
    if (after < before * (1 - VISIBILITY_DROP)) {
      findings.push({
        source: "visibility",
        findingType: "visibility-declining",
        stableKeyInput: `visibility-declining:${page}`,
        title: `${page} pierde visibilidad: ${before} → ${after} impresiones en 28 días`,
        detail: { page, before, after },
        sourceRefId: page,
      });
    }
  }

  const images = recent.filter((r) => r.type === "image");
  const imgImpr = sumBy(images, (r) => r.page, (r) => r.impressions);
  const imgClicks = sumBy(images, (r) => r.page, (r) => r.clicks);
  for (const [page, impressions] of imgImpr) {
    const clicks = imgClicks.get(page) ?? 0;
    if (impressions >= 200 && clicks / impressions < 0.01) {
      findings.push({
        source: "visibility",
        findingType: "image-opportunity",
        stableKeyInput: `image-opportunity:${page}`,
        title: `Las imágenes de ${page} salen ${impressions} veces en Google Imágenes y casi nadie entra (${clicks} clics)`,
        detail: { page, impressions, clicks },
        sourceRefId: page,
      });
    }
  }
  return findings;
}

export interface SegmentRow {
  page: string;
  device: string;
  country: string;
  impressions: number;
}

/** Un dispositivo o país cae más que la banda mientras el total de la página aguanta. */
export function extractSegmentFindings(recent: SegmentRow[], prior: SegmentRow[]): Finding[] {
  const findings: Finding[] = [];
  const pageRecent = sumBy(recent, (r) => r.page, (r) => r.impressions);
  const pagePrior = sumBy(prior, (r) => r.page, (r) => r.impressions);
  for (const dim of ["device", "country"] as const) {
    const key = (r: SegmentRow) => `${r.page}\u0000${r[dim]}`;
    const segRecent = sumBy(recent, key, (r) => r.impressions);
    const segPrior = sumBy(prior, key, (r) => r.impressions);
    for (const [k, before] of segPrior) {
      if (before < VISIBILITY_MIN_BASE) continue;
      const [page, value] = k.split("\u0000");
      const totalBefore = pagePrior.get(page) ?? 0;
      const totalAfter = pageRecent.get(page) ?? 0;
      if (totalBefore === 0 || totalAfter < totalBefore * (1 - VISIBILITY_DROP)) continue;
      const after = segRecent.get(k) ?? 0;
      if (after < before * (1 - VISIBILITY_DROP)) {
        findings.push({
          source: "visibility",
          findingType: "segment-declining",
          stableKeyInput: `segment-declining:${page}:${dim}:${value}`,
          title: `${page} cae en ${dim === "device" ? "el dispositivo" : "el país"} ${value} (${before} → ${after} impresiones) aunque el total aguanta`,
          detail: { page, dimension: dim, value, before, after },
          sourceRefId: page,
        });
      }
    }
  }
  return findings;
}

// ─── Exceso de indexación ───────────────────────────────────────────────────

/** Familias con contenido sin datos propios (Anexo B, index-bloat; §16.0 punto 5). */
export const BLOAT_FAMILIES: { name: string; pattern: RegExp }[] = [
  { name: "fotógrafos por provincia", pattern: /^\/fotografos-de-boda\/[^/]+\/?$/ },
  { name: "estadísticas por país", pattern: /^\/estadisticas[^/]*\/[^/]+\/?$/ },
];

export function extractIndexBloatFindings(sitemapUrls: string[], impressions90dByUrl: Map<string, number>): Finding[] {
  const findings: Finding[] = [];
  for (const family of BLOAT_FAMILIES) {
    const urls = sitemapUrls.filter((u) => {
      try {
        return family.pattern.test(new URL(u).pathname);
      } catch {
        return false;
      }
    });
    if (urls.length < 5) continue;
    const total = urls.reduce((acc, u) => acc + (impressions90dByUrl.get(u) ?? 0), 0);
    const perUrlPerMonth = total / urls.length / 3;
    if (perUrlPerMonth < 1) {
      findings.push({
        source: "visibility",
        findingType: "index-bloat",
        stableKeyInput: `index-bloat:${family.name}`,
        title: `${urls.length} URLs de ${family.name} con ${perUrlPerMonth.toFixed(2)} impresiones por URL al mes`,
        detail: { family: family.name, urls: urls.length, perUrlPerMonth },
        sourceRefId: family.name,
      });
    }
  }
  return findings;
}

// ─── Calidad de datos y salud de los procesos ───────────────────────────────

export interface DataQualityRow {
  date: Date;
  type: string;
  dataset: string;
  rowsReturned: number;
  isFinal: boolean;
  pageTotalClicks: number | null;
  queryDetailClicks: number | null;
}

export const QUERY_COVERAGE_MIN_CLICKS = 100;

export function extractDataQualityFindings(rows: DataQualityRow[], now: Date): Finding[] {
  const findings: Finding[] = [];
  // Días que ya deberían ser finales (GSC tarda hasta 5 días) de la última
  // semana sin el dataset de páginas de `web`.
  const finalWebPage = new Set(
    rows.filter((r) => r.type === "web" && r.dataset === "page" && r.isFinal).map((r) => r.date.toISOString().slice(0, 10)),
  );
  const missing: string[] = [];
  for (let d = 6; d <= 12; d++) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - d * DAY_MS).toISOString().slice(0, 10);
    if (!finalWebPage.has(day)) missing.push(day);
  }
  if (missing.length > 0 && rows.length > 0) {
    findings.push({
      source: "dataQuality",
      findingType: "data-quality-gap",
      stableKeyInput: "data-quality-gap:web-page",
      title: `Faltan datos finales de Search Console (páginas) de ${missing.length} días: ${missing.join(", ")}`,
      detail: { missing },
      sourceRefId: "web-page",
    });
  }
  // Cobertura de consultas < 30% durante 7 días seguidos.
  const coverage = rows
    .filter((r) => r.type === "web" && r.isFinal && r.pageTotalClicks && r.pageTotalClicks > 0 && r.queryDetailClicks !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 7);
  // Con poco volumen la anonimización de GSC se come casi todas las consultas
  // y el aviso no dice nada: se exige un mínimo de clics en la semana.
  const weekClicks = coverage.reduce((a, r) => a + (r.pageTotalClicks ?? 0), 0);
  if (coverage.length === 7 && weekClicks >= QUERY_COVERAGE_MIN_CLICKS && coverage.every((r) => (r.queryDetailClicks ?? 0) / (r.pageTotalClicks ?? 1) < 0.3)) {
    findings.push({
      source: "dataQuality",
      findingType: "data-quality-gap",
      stableKeyInput: "data-quality-gap:query-coverage",
      title: "Las consultas de Search Console cubren menos del 30% de los clics 7 días seguidos",
      detail: { days: coverage.map((r) => r.date.toISOString().slice(0, 10)) },
      sourceRefId: "query-coverage",
    });
  }
  return findings;
}

export interface HeartbeatRow {
  id: string;
  workflowName: string;
  lastRunAt: Date;
  lastStatus: string;
}

/** Un workflow que falla o que lleva más de 2 días sin correr (los diarios) o 9 (los semanales). */
export function extractCollectorFindings(rows: HeartbeatRow[], now: Date): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const maxAgeDays = /weekly/.test(row.workflowName) ? 9 : /monthly/.test(row.workflowName) ? 35 : 2;
    const stale = now.getTime() - row.lastRunAt.getTime() > maxAgeDays * DAY_MS;
    const failing = !/^(success|ok)$/i.test(row.lastStatus);
    if (!stale && !failing) continue;
    findings.push({
      source: "dataQuality",
      findingType: "collector-failing",
      stableKeyInput: `collector-failing:${row.workflowName}`,
      title: `El proceso ${row.workflowName} ${failing ? `terminó con «${row.lastStatus}»` : `no corre desde hace más de ${maxAgeDays} días`}`,
      detail: { workflowName: row.workflowName, lastStatus: row.lastStatus, lastRunAt: row.lastRunAt },
      sourceRefId: row.id,
    });
  }
  return findings;
}

// ─── Embudo orgánico ────────────────────────────────────────────────────────

export interface FunnelRow {
  date: Date;
  channel: string;
  registros: number;
  bodasPublicadas: number;
  pagos: number;
}

export const FUNNEL_MIN_N = 30;
/** Canales de buscador de la vista seo_funnel_daily (seo_referrer_channel). */
export const ORGANIC_CHANNELS = new Set(["google", "bing"]);

/**
 * Una etapa del embudo orgánico (registro → web publicada → pago) cae frente a
 * los 90 días anteriores. Compara tasas de paso entre etapas, con n ≥ 30 en
 * la etapa de origen de las dos ventanas.
 */
export function extractFunnelFindings(rows: FunnelRow[], now: Date): Finding[] {
  const organic = rows.filter((r) => ORGANIC_CHANNELS.has(r.channel));
  const recentStart = now.getTime() - 30 * DAY_MS;
  const priorStart = recentStart - 90 * DAY_MS;
  const sum = (from: number, to: number) => {
    const sel = organic.filter((r) => r.date.getTime() >= from && r.date.getTime() < to);
    return {
      registros: sel.reduce((a, r) => a + r.registros, 0),
      bodasPublicadas: sel.reduce((a, r) => a + r.bodasPublicadas, 0),
      pagos: sel.reduce((a, r) => a + r.pagos, 0),
    };
  };
  const recent = sum(recentStart, now.getTime());
  const prior = sum(priorStart, recentStart);
  const findings: Finding[] = [];
  const stages: { name: string; from: "registros" | "bodasPublicadas"; to: "bodasPublicadas" | "pagos" }[] = [
    { name: "registro → web publicada", from: "registros", to: "bodasPublicadas" },
    { name: "web publicada → pago", from: "bodasPublicadas", to: "pagos" },
  ];
  for (const stage of stages) {
    if (recent[stage.from] < FUNNEL_MIN_N || prior[stage.from] < FUNNEL_MIN_N) continue;
    const rRecent = recent[stage.to] / recent[stage.from];
    const rPrior = prior[stage.to] / prior[stage.from];
    if (rPrior > 0 && rRecent < rPrior * (1 - VISIBILITY_DROP)) {
      findings.push({
        source: "funnel",
        findingType: "funnel-drop",
        stableKeyInput: `funnel-drop:${stage.name}`,
        title: `Cae el paso ${stage.name} del embudo orgánico: ${(rPrior * 100).toFixed(1)}% → ${(rRecent * 100).toFixed(1)}%`,
        detail: { stage: stage.name, prior: rPrior, recent: rRecent, n: recent[stage.from] },
        sourceRefId: stage.name,
      });
    }
  }
  return findings;
}
