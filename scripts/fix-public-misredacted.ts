// scripts/fix-public-misredacted.ts
// Corrección de una sola vez: páginas públicas que se guardaron redactadas como privadas
// (p. ej. /tool, que antes se clasificaba como private-session). Para cada URL pública
// calcula la redacción antigua (`https://miwebdeboda.com/<privada:{hmac12}>`) y, si hay
// filas con ella, las reescribe con la URL pública normalizada y da por resuelto su
// PrivateIncident. Por defecto solo cuenta (--dry); con --apply escribe.
//
// Uso: tsx scripts/fix-public-misredacted.ts [--apply] [url ...]
// Sin URLs, usa las del sitemap actual.
import { prisma } from "../src/db";
import { fetchSitemapEntries } from "../src/collectors/urlInspectionCollector";
import { hmac12, requirePrivateUrlKey } from "../src/privacy/redact";
import { SITE_ORIGIN, isPrivateUrl, normalizeUrl } from "../src/privacy/sitePrivacy";

export interface FixCounts {
  pageDaily: number;
  segmentDaily: number;
  queryTyped: number;
  urlInspection: number;
  productionProbe: number;
  incidentsResolved: number;
}

export interface FixUrlResult extends FixCounts {
  url: string;
  urlHmac: string;
}

const emptyCounts = (): FixCounts => ({
  pageDaily: 0,
  segmentDaily: 0,
  queryTyped: 0,
  urlInspection: 0,
  productionProbe: 0,
  incidentsResolved: 0,
});

function hasRows(c: FixCounts): boolean {
  return Object.values(c).some((n) => n > 0);
}

/** Cuenta (y con apply, corrige) las filas de una URL pública guardada redactada. */
async function fixOne(url: string, key: string, apply: boolean, now: Date): Promise<FixUrlResult> {
  const publicUrl = normalizeUrl(url);
  const urlHmac = hmac12(url, key);
  const redacted = `${SITE_ORIGIN}/<privada:${urlHmac}>`;
  const counts = emptyCounts();

  const pageRows = await prisma.searchConsolePageDaily.findMany({
    where: { page: redacted },
    select: { id: true, date: true, type: true },
  });
  const segmentRows = await prisma.searchConsoleSegmentDaily.findMany({
    where: { page: redacted },
    select: { id: true, date: true, device: true, country: true, type: true },
  });
  const queryRows = await prisma.searchConsoleQueryTyped.findMany({
    where: { page: redacted },
    select: { id: true, date: true, query: true, type: true },
  });
  const inspectionWhere = {
    OR: [{ url: redacted }, { googleCanonical: redacted }, { userCanonical: redacted }],
  };
  const probeWhere = { OR: [{ url: redacted }, { finalUrl: redacted }, { canonical: redacted }] };
  counts.pageDaily = pageRows.length;
  counts.segmentDaily = segmentRows.length;
  counts.queryTyped = queryRows.length;
  counts.urlInspection = await prisma.urlInspection.count({ where: inspectionWhere });
  counts.productionProbe = await prisma.productionProbeResult.count({ where: probeWhere });
  counts.incidentsResolved = await prisma.privateIncident.count({ where: { urlHmac, resolvedAt: null } });

  if (!apply || !hasRows(counts)) return { url: publicUrl, urlHmac, ...counts };

  await prisma.$transaction(async (tx) => {
    // En las tablas con clave única, si ya hay una fila con la URL pública (de una
    // recogida posterior a la corrección), esa manda y la redactada se borra.
    for (const r of pageRows) {
      const clash = await tx.searchConsolePageDaily.findUnique({
        where: { date_page_type: { date: r.date, page: publicUrl, type: r.type } },
        select: { id: true },
      });
      if (clash) await tx.searchConsolePageDaily.delete({ where: { id: r.id } });
      else await tx.searchConsolePageDaily.update({ where: { id: r.id }, data: { page: publicUrl } });
    }
    for (const r of segmentRows) {
      const clash = await tx.searchConsoleSegmentDaily.findUnique({
        where: {
          date_page_device_country_type: {
            date: r.date,
            page: publicUrl,
            device: r.device,
            country: r.country,
            type: r.type,
          },
        },
        select: { id: true },
      });
      if (clash) await tx.searchConsoleSegmentDaily.delete({ where: { id: r.id } });
      else await tx.searchConsoleSegmentDaily.update({ where: { id: r.id }, data: { page: publicUrl } });
    }
    for (const r of queryRows) {
      const clash = await tx.searchConsoleQueryTyped.findUnique({
        where: { date_page_query_type: { date: r.date, page: publicUrl, query: r.query, type: r.type } },
        select: { id: true },
      });
      if (clash) await tx.searchConsoleQueryTyped.delete({ where: { id: r.id } });
      else await tx.searchConsoleQueryTyped.update({ where: { id: r.id }, data: { page: publicUrl } });
    }

    await tx.urlInspection.updateMany({ where: { url: redacted }, data: { url: publicUrl } });
    await tx.urlInspection.updateMany({ where: { googleCanonical: redacted }, data: { googleCanonical: publicUrl } });
    await tx.urlInspection.updateMany({ where: { userCanonical: redacted }, data: { userCanonical: publicUrl } });

    await tx.productionProbeResult.updateMany({ where: { url: redacted }, data: { url: publicUrl } });
    await tx.productionProbeResult.updateMany({ where: { finalUrl: redacted }, data: { finalUrl: publicUrl } });
    await tx.productionProbeResult.updateMany({ where: { canonical: redacted }, data: { canonical: publicUrl } });

    await tx.privateIncident.updateMany({ where: { urlHmac, resolvedAt: null }, data: { resolvedAt: now } });
  });

  return { url: publicUrl, urlHmac, ...counts };
}

export async function fixPublicMisredacted(
  opts: { urls?: string[]; apply?: boolean; key?: string; now?: Date; sitemapUrls?: () => Promise<string[]> } = {}
): Promise<{ results: FixUrlResult[]; totals: FixCounts; skippedPrivate: number }> {
  const key = requirePrivateUrlKey(opts.key);
  const apply = opts.apply ?? false;
  const now = opts.now ?? new Date();
  const sitemapUrls = opts.sitemapUrls ?? (async () => (await fetchSitemapEntries()).map((e) => e.url));
  const urls = opts.urls && opts.urls.length > 0 ? opts.urls : await sitemapUrls();

  const unique = new Map<string, string>();
  let skippedPrivate = 0;
  for (const url of urls) {
    let normalized: string;
    try {
      normalized = normalizeUrl(url);
    } catch {
      skippedPrivate += 1;
      continue;
    }
    // Solo se corrigen las que hoy son públicas: una privada debe seguir redactada.
    if (isPrivateUrl(normalized)) {
      skippedPrivate += 1;
      continue;
    }
    unique.set(normalized, normalized);
  }

  const results: FixUrlResult[] = [];
  const totals = emptyCounts();
  for (const url of unique.values()) {
    const r = await fixOne(url, key, apply, now);
    if (!hasRows(r)) continue;
    results.push(r);
    for (const k of Object.keys(totals) as (keyof FixCounts)[]) totals[k] += r[k];
  }
  return { results, totals, skippedPrivate };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const urls = args.filter((a) => !a.startsWith("--"));

  fixPublicMisredacted({ urls, apply })
    .then(({ results, totals, skippedPrivate }) => {
      console.log(apply ? "Modo --apply: filas reescritas." : "Modo --dry: solo se cuenta, no se escribe nada.");
      for (const r of results) {
        console.log(
          `${r.url} (<privada:${r.urlHmac}>): pageDaily=${r.pageDaily} segmentDaily=${r.segmentDaily} ` +
            `queryTyped=${r.queryTyped} urlInspection=${r.urlInspection} productionProbe=${r.productionProbe} ` +
            `incidentes=${r.incidentsResolved}`
        );
      }
      console.log(`Total: ${JSON.stringify(totals)}. URLs privadas o no válidas omitidas: ${skippedPrivate}.`);
      process.exit(0);
    })
    .catch((error) => {
      console.error("fix-public-misredacted failed:", error);
      process.exit(1);
    });
}
