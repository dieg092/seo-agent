// src/competitors/reader.ts
// Lector de competidores (§16.3). Por dominio: robots.txt, sus sitemaps y como
// mucho 50 páginas al mes, con una petición cada 5 s y respetando robots.txt.
// De cada página se guarda solo la estructura (title, h1, h2/h3, tipos de
// schema, número de palabras): nunca el texto. Todo lo que sale de aquí está
// contaminado (tainted): sirve para hallazgos A2, nunca para código.
import { gunzipSync } from "node:zlib";
import { parseRobotsTxt, ALLOW_ALL, type RobotsPolicy } from "../crawler/robotsTxt";

export const COMPETITOR_USER_AGENT = "miwebdeboda-seo-agent-reader/1.0 (+https://miwebdeboda.com)";
export const MONTHLY_PAGE_BUDGET = 50;
export const PAGES_PER_RUN = 12;
export const REQUEST_DELAY_MS = 5_000;
export const MAX_SITEMAPS_PER_RUN = 4;
const MAX_BYTES = 3_000_000;
const MAX_HEADINGS = 20;
const MAX_TEXT = 160;
/** No se vuelve a leer una página en 90 días. */
export const REFETCH_DAYS = 90;

export interface FetchResult {
  status: number;
  text: string;
  contentType: string;
}
export type Fetcher = (url: string) => Promise<FetchResult>;

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    headers: { "user-agent": COMPETITOR_USER_AGENT, accept: "text/html,application/xml;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = res.headers.get("content-type") ?? "";
  let bytes = new Uint8Array(await res.arrayBuffer());
  // Sitemaps .xml.gz: gzip sin Content-Encoding, hay que descomprimirlos aquí.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_BYTES }));
    } catch {
      bytes = new Uint8Array();
    }
  }
  const text = new TextDecoder().decode(bytes.byteLength > MAX_BYTES ? bytes.slice(0, MAX_BYTES) : bytes);
  return { status: res.status, text, contentType };
};

const clip = (s: string | null | undefined, max = MAX_TEXT) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, " "));

/** Líneas `Sitemap:` de un robots.txt. */
export function robotsSitemaps(robots: string): string[] {
  return [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
}

/** URLs de un sitemap: las páginas (<url>) y los sitemaps hijos (<sitemap>). */
export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const clean = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const locs = (block: string) => [...clean.matchAll(new RegExp(`<${block}>[\\s\\S]*?<loc>\\s*([^<\\s]+)\\s*</loc>[\\s\\S]*?</${block}>`, "gi"))].map((m) => decodeEntities(m[1]));
  return { pages: locs("url"), sitemaps: locs("sitemap") };
}

export interface PageStructure {
  title: string | null;
  h1: string | null;
  headings: string[];
  jsonLdTypes: string[];
  wordCount: number;
  lang: string | null;
  noindex: boolean;
}

function jsonLdTypesOf(html: string): string[] {
  const types = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const t = (node as Record<string, unknown>)["@type"];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string") types.add(x.slice(0, 60));
    const graph = (node as Record<string, unknown>)["@graph"];
    if (graph) visit(graph);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1]));
    } catch {
      // JSON-LD roto: se ignora
    }
  }
  return [...types].sort();
}

/** Estructura de una página HTML, sin guardar su texto. */
export function extractStructure(html: string): PageStructure {
  const title = clip(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""));
  const h1 = clip(stripTags(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] ?? ""));
  const headings = [...html.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map((m) => clip(stripTags(m[2]), 120))
    .filter((h): h is string => !!h)
    .slice(0, MAX_HEADINGS);
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = stripTags(body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " "));
  const wordCount = text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  const lang = clip(/<html[^>]*\blang=["']([^"']+)["']/i.exec(html)?.[1] ?? "", 12);
  const robots = /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  return { title, h1, headings, jsonLdTypes: jsonLdTypesOf(html), wordCount, lang, noindex: /noindex/i.test(robots) };
}

/** Sitemaps de fotos, imágenes o vídeos. */
export const isMediaSitemap = (url: string) => /(image|photo|video|foto)/i.test(new URL(url, "https://x").pathname);

const depth = (path: string) => path.split("/").filter(Boolean).length;

/**
 * Qué páginas leer en esta pasada: las que no se han leído en 90 días,
 * primero las menos profundas (arquitectura y páginas comerciales) y, a igual
 * profundidad, en orden estable. Solo del mismo dominio y permitidas por robots.
 */
export function pickPages(candidates: string[], domain: string, recentlyFetched: Set<string>, policy: RobotsPolicy, budget: number): string[] {
  if (budget <= 0) return [];
  const seen = new Set<string>();
  const ok: { url: string; path: string }[] = [];
  for (const raw of candidates) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(u.protocol)) continue;
    const host = u.hostname.replace(/^www\./, "");
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    u.hash = "";
    const url = u.toString();
    if (seen.has(url) || recentlyFetched.has(url)) continue;
    seen.add(url);
    if (!policy.isAllowed(u.pathname + u.search)) continue;
    ok.push({ url, path: u.pathname });
  }
  ok.sort((a, b) => depth(a.path) - depth(b.path) || a.url.localeCompare(b.url));
  if (ok.length <= budget) return ok.map((x) => x.url);
  // La mitad, las menos profundas (arquitectura); la otra mitad, repartida por todo el
  // sitemap para no leer solo una sección (p. ej. todas las provincias de un listado).
  const head = Math.ceil(budget / 2);
  const rest = ok.slice(head);
  const stride = rest.length / (budget - head);
  const spread = Array.from({ length: budget - head }, (_, i) => rest[Math.floor(i * stride)]);
  return [...ok.slice(0, head), ...spread].map((x) => x.url);
}

export interface ReadDeps {
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** Páginas ya leídas del dominio este mes y en los últimos 90 días. */
  fetchedThisMonth: number;
  recentlyFetched: Set<string>;
}

export interface ReadPage extends PageStructure {
  url: string;
  path: string;
  status: number;
}

/** Una pasada sobre un dominio. Devuelve las páginas leídas (sin texto) y notas. */
export async function readCompetitor(domain: string, deps: ReadDeps): Promise<{ pages: ReadPage[]; notes: string[] }> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const notes: string[] = [];
  let first = true;
  const get = async (url: string) => {
    if (!first) await sleep(REQUEST_DELAY_MS);
    first = false;
    return fetcher(url);
  };

  const budget = Math.min(PAGES_PER_RUN, MONTHLY_PAGE_BUDGET - deps.fetchedThisMonth);
  if (budget <= 0) return { pages: [], notes: [`${domain}: cupo mensual gastado`] };

  const origin = `https://www.${domain}`;
  let policy: RobotsPolicy = ALLOW_ALL;
  let sitemapQueue: string[] = [];
  try {
    const r = await get(`${origin}/robots.txt`);
    if (r.status >= 200 && r.status < 300) {
      policy = parseRobotsTxt(r.text, COMPETITOR_USER_AGENT);
      sitemapQueue = robotsSitemaps(r.text);
    } else if (r.status >= 500 || [401, 403, 429].includes(r.status)) {
      // Sin poder leer robots.txt no se rastrea (RFC 9309: 5xx = todo prohibido). Un 401/403
      // es que el sitio rechaza al robot: tampoco se insiste.
      return { pages: [], notes: [`${domain}: robots.txt responde ${r.status}, no se lee`] };
    }
  } catch (e) {
    return { pages: [], notes: [`${domain}: robots.txt no responde (${(e as Error).message.slice(0, 60)})`] };
  }
  if (sitemapQueue.length === 0) sitemapQueue = [`${origin}/sitemap.xml`];
  sitemapQueue = sitemapQueue.filter((u) => !isMediaSitemap(u));

  const candidates: string[] = [];
  let sitemapsRead = 0;
  while (sitemapQueue.length > 0 && sitemapsRead < MAX_SITEMAPS_PER_RUN && candidates.length < budget * 20) {
    const sm = sitemapQueue.shift()!;
    try {
      const smUrl = new URL(sm);
      if (!policy.isAllowed(smUrl.pathname + smUrl.search)) continue;
    } catch {
      continue;
    }
    sitemapsRead += 1;
    try {
      const r = await get(sm);
      if (r.status !== 200) continue;
      const parsed = parseSitemap(r.text);
      candidates.push(...parsed.pages);
      // En profundidad: los hijos de un índice van delante, para llegar a páginas con pocas
      // peticiones. Los de fotos y vídeos no se leen (no dicen nada de temas ni de arquitectura).
      // Se rotan con lo ya leído este mes, para que cada pasada entre por otra sección.
      const kids = parsed.sitemaps.filter((u) => !isMediaSitemap(u));
      const shift = kids.length ? Math.floor(deps.fetchedThisMonth / PAGES_PER_RUN) % kids.length : 0;
      sitemapQueue.unshift(...kids.slice(shift), ...kids.slice(0, shift));
    } catch {
      // un sitemap que falla no para la pasada
    }
  }
  if (candidates.length === 0) notes.push(`${domain}: sin páginas en los sitemaps leídos`);

  const pages: ReadPage[] = [];
  for (const url of pickPages(candidates, domain, deps.recentlyFetched, policy, budget)) {
    try {
      const r = await get(url);
      const isHtml = /html/i.test(r.contentType) || /^\s*<!doctype html|<html/i.test(r.text.slice(0, 500));
      const s = r.status === 200 && isHtml ? extractStructure(r.text) : { title: null, h1: null, headings: [], jsonLdTypes: [], wordCount: 0, lang: null, noindex: false };
      pages.push({ url, path: new URL(url).pathname, status: r.status, ...s });
      if (r.status === 429 || r.status === 403) {
        notes.push(`${domain}: responde ${r.status}, se para hasta la próxima pasada`);
        break;
      }
    } catch (e) {
      notes.push(`${domain}: ${new URL(url).pathname} falla (${(e as Error).message.slice(0, 60)})`);
    }
  }
  notes.push(`${domain}: ${pages.length} páginas leídas`);
  return { pages, notes };
}
