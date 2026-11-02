// Sonda diaria de producción (§10.7 de la spec):
//   (a) sitemap:        cada URL del sitemap da 200, es indexable, su canónica es ella misma
//                       y su clase es `public`;
//   (b) private-sample: las muestras privadas de prueba (PRIVATE_PROBE_URLS) tienen noindex
//                       (o 401/403/404, o redirigen al login) y no están en el sitemap;
//   (c) gsc-private:    los PrivateIncident abiertos con origen GSC de los últimos 28 días,
//                       siempre en rojo. No se vuelven a pedir: ya están redactados.
// Las URLs privadas se guardan redactadas; una privada expuesta abre un PrivateIncident.
import * as cheerio from "cheerio";
import { prisma } from "../db";
import { fetchSitemapEntries } from "../collectors/urlInspectionCollector";
import { recordPrivateExposure } from "../privacy/privateIncidents";
import { redactUrl, requirePrivateUrlKey } from "../privacy/redact";
import { SITE_ORIGIN, isPrivateUrl, normalizeUrl } from "../privacy/sitePrivacy";

export const PROBE_CONCURRENCY = 4;
export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_USER_AGENT = "miwebdeboda-seo-agent";
const GSC_PRIVATE_WINDOW_DAYS = 28;
// Orígenes que escribe searchConsoleFullCollector (`gsc:<type>`).
const GSC_SOURCES = ["web", "image", "video", "news", "discover", "googleNews"].map((t) => `gsc:${t}`);

export interface ProbeRow {
  url: string;
  kind: "sitemap" | "private-sample" | "gsc-private";
  status: number | null;
  finalUrl: string | null;
  metaRobots: string | null;
  xRobotsTag: string | null;
  canonical: string | null;
  ok: boolean;
  reason: string | null;
}

export interface FetchedPage {
  status: number;
  finalUrl: string;
  /** Cabeceras con el nombre en minúsculas. */
  headers: Record<string, string>;
  html: string;
}

export type FetchPageFn = (url: string) => Promise<FetchedPage>;

function hasNoindex(value: string | null): boolean {
  return value !== null && /\bnoindex\b|\bnone\b/i.test(value);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

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
    // Una URL que no se puede leer se trata como privada (falla del lado seguro).
    return true;
  }
}

/** Evalúa la respuesta de una página según el tipo de comprobación. No guarda nada. */
export function evaluateProbe(
  kind: ProbeRow["kind"],
  url: string,
  r: { status: number; finalUrl: string; headers: Record<string, string>; html: string }
): Omit<ProbeRow, "kind" | "url"> {
  const $ = cheerio.load(r.html ?? "");
  const robotsMetas = $('meta[name="robots" i], meta[name="googlebot" i]')
    .toArray()
    .map((el) => ($(el).attr("content") ?? "").trim())
    .filter((c) => c.length > 0);
  const metaRobots = robotsMetas.length > 0 ? robotsMetas.join(", ") : null;
  const xRobotsTag = r.headers["x-robots-tag"] ?? null;
  const rawCanonical = $('link[rel="canonical" i]').first().attr("href")?.trim();
  let canonical: string | null = null;
  if (rawCanonical) {
    try {
      canonical = new URL(rawCanonical, r.finalUrl || url).toString();
    } catch {
      canonical = rawCanonical;
    }
  }
  const noindex = hasNoindex(metaRobots) || hasNoindex(xRobotsTag);
  const base = { status: r.status, finalUrl: r.finalUrl, metaRobots, xRobotsTag, canonical };

  if (kind === "gsc-private") return { ...base, ok: false, reason: "privada en GSC" };

  if (kind === "private-sample") {
    const loginRedirect = /^\/login(\/|$)/.test(pathOf(r.finalUrl));
    if (noindex || [401, 403, 404].includes(r.status) || loginRedirect) return { ...base, ok: true, reason: null };
    return { ...base, ok: false, reason: `privada indexable (status ${r.status} sin noindex)` };
  }

  // sitemap
  if (safeIsPrivate(url)) return { ...base, ok: false, reason: "privada en el sitemap" };
  if (r.status !== 200) return { ...base, ok: false, reason: `status ${r.status}` };
  const self = safeNormalize(url);
  if (safeNormalize(r.finalUrl) !== self) return { ...base, ok: false, reason: "redirige a otra url" };
  if (noindex) return { ...base, ok: false, reason: "noindex" };
  if (!canonical) return { ...base, ok: false, reason: "sin canonica" };
  if (safeNormalize(canonical) !== self) return { ...base, ok: false, reason: "canonica a otra url" };
  return { ...base, ok: true, reason: null };
}

/** Descarga una página siguiendo redirecciones, con timeout y user-agent propio. */
export const defaultFetchPage: FetchPageFn = async (url) => {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { "User-Agent": PROBE_USER_AGENT },
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const isHtml = (headers["content-type"] ?? "").includes("html");
  const html = isHtml ? await response.text() : "";
  if (!isHtml) await response.body?.cancel();
  return { status: response.status, finalUrl: response.url || url, headers, html };
};

/** Lista de muestras privadas de PRIVATE_PROBE_URLS, separadas por comas o espacios. */
export function parsePrivateProbeUrls(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Incidentes abiertos con origen GSC vistos en los últimos 28 días, como URL redactada. */
async function defaultGscPrivatePages(now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - GSC_PRIVATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const incidents = await prisma.privateIncident.findMany({
    where: { resolvedAt: null, lastSeenAt: { gte: since, lte: now }, sources: { hasSome: GSC_SOURCES } },
    select: { urlHmac: true },
    orderBy: { firstSeenAt: "asc" },
  });
  return incidents.map((i) => `${SITE_ORIGIN}/<privada:${i.urlHmac}>`);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function probeProduction(
  deps: {
    fetchPage?: FetchPageFn;
    sitemapUrls?: () => Promise<string[]>;
    privateSamples?: string[];
    gscPrivatePages?: () => Promise<string[]>;
    record?: typeof recordPrivateExposure;
    now?: Date;
  } = {}
): Promise<{ results: ProbeRow[]; failures: number }> {
  // Sin clave no se escribe nada: nunca se guarda una URL privada en claro.
  const key = requirePrivateUrlKey();
  const fetchPage = deps.fetchPage ?? defaultFetchPage;
  const record = deps.record ?? recordPrivateExposure;
  const now = deps.now ?? new Date();
  const privateSamples = deps.privateSamples ?? parsePrivateProbeUrls(process.env.PRIVATE_PROBE_URLS);
  const sitemapUrls =
    deps.sitemapUrls ?? (async () => (await fetchSitemapEntries()).map((e) => e.url));
  const gscPrivatePages = deps.gscPrivatePages ?? (() => defaultGscPrivatePages(now));

  const sitemap = [...new Set(await sitemapUrls())];
  const sitemapSet = new Set(sitemap.map(safeNormalize).filter((u): u is string => u !== null));

  const fetchAndEvaluate = async (kind: ProbeRow["kind"], url: string): Promise<ProbeRow> => {
    try {
      const page = await fetchPage(url);
      return { kind, url, ...evaluateProbe(kind, url, page) };
    } catch (error) {
      // El mensaje podría incluir la URL, que puede ser privada.
      const message = ((error as Error)?.message ?? String(error)).split(url).join("<url>");
      return {
        kind,
        url,
        status: null,
        finalUrl: null,
        metaRobots: null,
        xRobotsTag: null,
        canonical: null,
        ok: false,
        reason: `error: ${message}`.slice(0, 300),
      };
    }
  };

  // (a) sitemap. Las privadas no se abren: se marcan y se registran como incidente.
  const sitemapRows = await mapWithConcurrency(sitemap, PROBE_CONCURRENCY, async (url): Promise<ProbeRow> => {
    if (safeIsPrivate(url)) {
      await record(url, "probe:sitemap");
      return {
        kind: "sitemap",
        url,
        status: null,
        finalUrl: null,
        metaRobots: null,
        xRobotsTag: null,
        canonical: null,
        ok: false,
        reason: "privada en el sitemap",
      };
    }
    return fetchAndEvaluate("sitemap", url);
  });

  // (b) muestras privadas de prueba (B1). Sin muestras, se deja constancia.
  let sampleRows: ProbeRow[];
  if (privateSamples.length === 0) {
    sampleRows = [
      {
        kind: "private-sample",
        url: `${SITE_ORIGIN}/`,
        status: null,
        finalUrl: null,
        metaRobots: null,
        xRobotsTag: null,
        canonical: null,
        ok: true,
        reason: "PENDIENTE B1",
      },
    ];
  } else {
    sampleRows = await mapWithConcurrency(privateSamples, PROBE_CONCURRENCY, async (url) => {
      const row = await fetchAndEvaluate("private-sample", url);
      const normalized = safeNormalize(url);
      const inSitemap = normalized !== null && sitemapSet.has(normalized);
      const indexable = row.status !== null && !row.ok;
      if (inSitemap) {
        // Ya se registró como privada en el sitemap si su clase es privada; si no, aquí.
        if (!safeIsPrivate(url)) await record(url, "probe:sitemap");
        row.ok = false;
        row.reason = row.reason ? `${row.reason}; en el sitemap` : "en el sitemap";
      }
      if (indexable) await record(url, "probe:private-sample");
      return row;
    });
  }

  // (c) páginas privadas que GSC ha mostrado: siempre en rojo.
  const gscRows: ProbeRow[] = (await gscPrivatePages()).map((url) => ({
    kind: "gsc-private",
    url,
    status: null,
    finalUrl: null,
    metaRobots: null,
    xRobotsTag: null,
    canonical: null,
    ok: false,
    reason: "privada en GSC",
  }));

  const results = [...sitemapRows, ...sampleRows, ...gscRows];

  // Se guarda redactado: url, finalUrl y canónica pueden ser privadas.
  const redact = (u: string | null): string | null => {
    if (u === null) return null;
    if (u.includes("<privada:")) return u;
    try {
      return redactUrl(u, key);
    } catch {
      return null;
    }
  };
  if (results.length > 0) {
    await prisma.productionProbeResult.createMany({
      data: results.map((r) => ({
        runAt: now,
        url: redact(r.url) ?? `${SITE_ORIGIN}/<no-valida>`,
        kind: r.kind,
        status: r.status,
        finalUrl: redact(r.finalUrl),
        metaRobots: r.metaRobots,
        xRobotsTag: r.xRobotsTag,
        canonical: redact(r.canonical),
        ok: r.ok,
        reason: r.reason,
      })),
    });
  }

  return { results, failures: results.filter((r) => !r.ok).length };
}
