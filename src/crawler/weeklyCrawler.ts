// Rastreador ligero semanal (§11 de la spec, ADR-07).
// - Parte del sitemap de la web y sigue los enlaces internos que encuentra.
// - Respeta robots.txt, con concurrencia baja, una pausa entre peticiones y un límite de páginas.
// - Solo abre rutas `public` según src/privacy: nunca webs de parejas, invitaciones ni rutas
//   con sesión. Tampoco pide imágenes ni otros ficheros estáticos.
// - No sigue redirecciones: guarda el destino y, si es público, lo encola como otra URL.
// - Guarda una fila por URL en CrawlPage. Lo que apunte a una ruta privada se guarda redactado.
import * as cheerio from "cheerio";
import { prisma } from "../db";
import { getEnv } from "../env";
import { fetchSitemapEntries } from "../collectors/urlInspectionCollector";
import { redactUrl, requirePrivateUrlKey } from "../privacy/redact";
import { SITE_HOST, SITE_ORIGIN, classifyPath, normalizeUrl } from "../privacy/sitePrivacy";
import { ALLOW_ALL, parseRobotsTxt, type RobotsPolicy } from "./robotsTxt";

export const CRAWL_USER_AGENT = "miwebdeboda-seo-agent-crawler";
export const CRAWL_CONCURRENCY = 2;
export const CRAWL_MAX_PAGES = 600;
export const CRAWL_MAX_DEPTH = 3;
export const CRAWL_DELAY_MS = 300;
export const CRAWL_TIMEOUT_MS = 15_000;
/** Lo que se lee como mucho de cada HTML; el resto se descarta. */
export const CRAWL_MAX_HTML_BYTES = 3_000_000;
const MAX_LINKS_PER_PAGE = 500;
const MAX_H1 = 10;
const MAX_TEXT = 500;

// Ficheros que no se piden nunca (imágenes, vídeo, fuentes, estáticos).
const ASSET_EXTENSION = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|tiff?|heic|mp4|webm|mov|mp3|wav|woff2?|ttf|otf|eot|css|js|mjs|map|zip|pdf)$/i;

export interface CrawlResponse {
  status: number;
  /** Cabeceras con el nombre en minúsculas. */
  headers: Record<string, string>;
  /** Cuerpo si es HTML; cadena vacía si no. */
  html: string;
  /** Bytes del cuerpo (leídos o declarados en content-length). */
  bytes: number | null;
}

export type CrawlFetchFn = (url: string) => Promise<CrawlResponse>;

export interface CrawlPageRow {
  url: string;
  inSitemap: boolean;
  depth: number;
  blockedByRobots: boolean;
  status: number | null;
  redirectTo: string | null;
  contentType: string | null;
  bytes: number | null;
  durationMs: number | null;
  canonical: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  title: string | null;
  h1: string[];
  internalLinks: string[];
  privateLinkCount: number;
  error: string | null;
}

export interface CrawlSummary {
  runAt: Date;
  pages: CrawlPageRow[];
  /** URLs o enlaces privados que no se abrieron (sitemap, enlaces o redirecciones). */
  skippedPrivate: number;
  skippedAssets: number;
  /** URLs que se quedaron sin pedir por el límite de páginas o de profundidad. */
  skippedByLimit: number;
}

function canonicalHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function clip(value: string | undefined | null, max = MAX_TEXT): string | null {
  if (value === undefined || value === null) return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/** Lee el cuerpo hasta `max` bytes y descarta el resto. */
async function readLimited(response: Response, max: number): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bytes: 0 };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), bytes: total };
}

/** GET sin seguir redirecciones, con timeout y user-agent propio. Solo lee el cuerpo si es HTML. */
export const defaultCrawlFetch: CrawlFetchFn = async (url) => {
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
    headers: { "User-Agent": CRAWL_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const declared = Number(headers["content-length"]);
  const declaredBytes = Number.isFinite(declared) && headers["content-length"] !== undefined ? declared : null;
  const isHtml = (headers["content-type"] ?? "").includes("html");
  if (!isHtml || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    return { status: response.status, headers, html: "", bytes: declaredBytes };
  }
  const { text, bytes } = await readLimited(response, CRAWL_MAX_HTML_BYTES);
  return { status: response.status, headers, html: text, bytes: declaredBytes ?? bytes };
};

/** Descarga un texto (robots.txt, sitemap) sin seguir redirecciones fuera de la base. */
async function defaultFetchText(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(CRAWL_TIMEOUT_MS),
    headers: { "User-Agent": CRAWL_USER_AGENT },
  });
  return { status: response.status, text: await response.text() };
}

/**
 * Política de robots.txt. 4xx: no hay robots.txt y se permite todo. 5xx o error de red:
 * se lanza un error y no se rastrea nada (lo mismo que haría Google).
 */
export async function loadRobotsPolicy(
  baseUrl: string,
  fetchText: (url: string) => Promise<{ status: number; text: string }> = defaultFetchText
): Promise<RobotsPolicy> {
  const { status, text } = await fetchText(`${baseUrl}/robots.txt`);
  if (status >= 200 && status < 300) return parseRobotsTxt(text, CRAWL_USER_AGENT);
  if (status >= 400 && status < 500) return ALLOW_ALL;
  throw new Error(`robots.txt respondió ${status}: no se rastrea`);
}

export interface CrawlDeps {
  /** Origen al que se piden las páginas. Por defecto, SITE_BASE_URL. */
  baseUrl?: string;
  fetchPage?: CrawlFetchFn;
  fetchText?: (url: string) => Promise<{ status: number; text: string }>;
  /** URLs del sitemap. Por defecto se lee `${baseUrl}/sitemap.xml` (y sus hijos). */
  sitemapUrls?: () => Promise<string[]>;
  concurrency?: number;
  maxPages?: number;
  maxDepth?: number;
  delayMs?: number;
  now?: Date;
  /** false para no escribir en la BD (pruebas en seco). */
  persist?: boolean;
}

interface QueueItem {
  /** Ruta con query, tal como se pide al servidor. */
  path: string;
  /** URL normalizada sobre miwebdeboda.com: clave de deduplicado y valor guardado. */
  key: string;
  depth: number;
}

export async function crawlSite(deps: CrawlDeps = {}): Promise<CrawlSummary> {
  // Sin clave no se escribe nada: los destinos privados se guardan redactados.
  const key = requirePrivateUrlKey();
  const baseUrl = (deps.baseUrl ?? getEnv("SITE_BASE_URL")).replace(/\/+$/, "");
  const base = new URL(baseUrl);
  const baseHost = canonicalHost(base.host);
  const fetchPage = deps.fetchPage ?? defaultCrawlFetch;
  const fetchText = deps.fetchText ?? defaultFetchText;
  const concurrency = Math.max(1, deps.concurrency ?? CRAWL_CONCURRENCY);
  const maxPages = deps.maxPages ?? CRAWL_MAX_PAGES;
  const maxDepth = deps.maxDepth ?? CRAWL_MAX_DEPTH;
  const delayMs = deps.delayMs ?? CRAWL_DELAY_MS;
  const runAt = deps.now ?? new Date();

  /** Ruta con query si la URL es de nuestra web (la base o miwebdeboda.com); si no, null. */
  const internalPath = (url: URL): string | null => {
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = canonicalHost(url.host);
    if (host !== baseHost && host !== SITE_HOST) return null;
    return `${url.pathname}${url.search}`;
  };
  const siteKey = (path: string): string => normalizeUrl(`${SITE_ORIGIN}${path}`);
  const isPublicPath = (path: string): boolean => classifyPath(path) === "public";
  /** Para guardar destinos (canónica, redirección): públicos normalizados, privados redactados. */
  const storeTarget = (raw: string, relativeTo: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(raw, relativeTo);
    } catch {
      return null;
    }
    const path = internalPath(parsed);
    try {
      return redactUrl(path !== null ? `${SITE_ORIGIN}${path}` : parsed.toString(), key);
    } catch {
      return null;
    }
  };

  const robots = await loadRobotsPolicy(baseUrl, fetchText);

  // El sitemap se pide a la base: un índice que apunte a miwebdeboda.com se reescribe a la base.
  const rebase = (url: string): string => {
    try {
      const parsed = new URL(url);
      const path = internalPath(parsed);
      return path !== null ? `${baseUrl}${path}` : url;
    } catch {
      return url;
    }
  };
  const sitemapUrls =
    deps.sitemapUrls ??
    (async () =>
      (
        await fetchSitemapEntries({
          baseUrl,
          fetchXml: async (url) => {
            const { status, text } = await fetchText(rebase(url));
            if (status < 200 || status >= 300) throw new Error(`sitemap respondió ${status}`);
            return text;
          },
        })
      ).map((e) => e.url));

  let skippedPrivate = 0;
  let skippedAssets = 0;
  let skippedByLimit = 0;
  const seen = new Set<string>();
  const sitemapKeys = new Set<string>();
  const queue: QueueItem[] = [];

  /** Encola si es interna, pública, no es un fichero estático y no se ha visto. */
  const enqueue = (url: URL, depth: number, fromSitemap: boolean): void => {
    const path = internalPath(url);
    if (path === null) return;
    if (!isPublicPath(url.pathname)) {
      skippedPrivate += 1;
      return;
    }
    if (ASSET_EXTENSION.test(url.pathname)) {
      skippedAssets += 1;
      return;
    }
    const k = siteKey(path);
    if (fromSitemap) sitemapKeys.add(k);
    if (seen.has(k)) return;
    seen.add(k);
    if (depth > maxDepth) {
      skippedByLimit += 1;
      return;
    }
    queue.push({ path, key: k, depth });
  };

  for (const loc of await sitemapUrls()) {
    try {
      enqueue(new URL(loc), 0, true);
    } catch {
      // Una <loc> ilegible no se pide.
    }
  }

  const pages: CrawlPageRow[] = [];
  let started = 0;

  const crawlOne = async (item: QueueItem): Promise<void> => {
    const row: CrawlPageRow = {
      url: item.key,
      inSitemap: sitemapKeys.has(item.key),
      depth: item.depth,
      blockedByRobots: false,
      status: null,
      redirectTo: null,
      contentType: null,
      bytes: null,
      durationMs: null,
      canonical: null,
      metaRobots: null,
      xRobotsTag: null,
      title: null,
      h1: [],
      internalLinks: [],
      privateLinkCount: 0,
      error: null,
    };
    pages.push(row);

    if (!robots.isAllowed(item.path)) {
      row.blockedByRobots = true;
      return;
    }

    const fetchUrl = `${baseUrl}${item.path}`;
    const t0 = Date.now();
    let response: CrawlResponse;
    try {
      response = await fetchPage(fetchUrl);
    } catch (error) {
      row.durationMs = Date.now() - t0;
      row.error = clip(`error: ${(error as Error)?.message ?? String(error)}`, 300);
      return;
    }
    row.durationMs = Date.now() - t0;
    row.status = response.status;
    row.bytes = response.bytes;
    row.contentType = clip(response.headers["content-type"], 200);
    row.xRobotsTag = clip(response.headers["x-robots-tag"], 300);

    const location = response.headers["location"];
    if (response.status >= 300 && response.status < 400 && location) {
      row.redirectTo = storeTarget(location, fetchUrl);
      try {
        const target = new URL(location, fetchUrl);
        // El destino cuenta como enlace de la misma profundidad (no se baja un nivel).
        if (internalPath(target) !== null) enqueue(target, item.depth, false);
      } catch {
        // Location ilegible: queda la fila con el estado.
      }
      return;
    }

    if (!response.html) return;
    const $ = cheerio.load(response.html);
    row.title = clip($("title").first().text());
    row.h1 = $("h1")
      .toArray()
      .slice(0, MAX_H1)
      .map((el) => clip($(el).text(), 300))
      .filter((t): t is string => t !== null);
    const robotsMetas = $('meta[name="robots" i], meta[name="googlebot" i]')
      .toArray()
      .map((el) => ($(el).attr("content") ?? "").trim())
      .filter((c) => c.length > 0);
    row.metaRobots = robotsMetas.length > 0 ? clip(robotsMetas.join(", "), 300) : null;
    const rawCanonical = $('link[rel="canonical" i]').first().attr("href")?.trim();
    row.canonical = rawCanonical ? storeTarget(rawCanonical, fetchUrl) : null;

    // Solo <a href>: las imágenes y demás recursos no se miran.
    const links = new Set<string>();
    for (const el of $("a[href]").toArray()) {
      const href = ($(el).attr("href") ?? "").trim();
      if (href.length === 0 || href.startsWith("#")) continue;
      let target: URL;
      try {
        target = new URL(href, fetchUrl);
      } catch {
        continue;
      }
      const path = internalPath(target);
      if (path === null) continue;
      if (!isPublicPath(target.pathname)) {
        row.privateLinkCount += 1;
        skippedPrivate += 1;
        continue;
      }
      if (ASSET_EXTENSION.test(target.pathname)) {
        skippedAssets += 1;
        continue;
      }
      if (links.size < MAX_LINKS_PER_PAGE) links.add(siteKey(path));
      enqueue(target, item.depth + 1, false);
    }
    row.internalLinks = [...links];
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let active = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift();
      if (!item) {
        if (active === 0) return;
        await sleep(10);
        continue;
      }
      if (started >= maxPages) {
        skippedByLimit += 1;
        continue;
      }
      started += 1;
      active += 1;
      try {
        await crawlOne(item);
      } finally {
        active -= 1;
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (deps.persist !== false && pages.length > 0) {
    await prisma.crawlPage.createMany({ data: pages.map((p) => ({ runAt, ...p })) });
  }

  return { runAt, pages, skippedPrivate, skippedAssets, skippedByLimit };
}
