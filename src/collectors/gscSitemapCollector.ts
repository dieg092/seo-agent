// src/collectors/gscSitemapCollector.ts
// Estado de los sitemaps según Search Console (sitemaps.list). Cada ejecución guarda
// una foto por sitemap en GscSitemapStatus; el histórico permite ver cuánto tiempo
// lleva un sitemap pendiente o sin descargarse.
import { google } from "googleapis";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { getEnv } from "../env";

// Forma de cada sitemap tal como lo devuelve la API (WmxSitemap). errors y warnings
// llegan como cadenas (int64) y las fechas en RFC 3339.
export interface GscSitemapApi {
  path?: string | null;
  lastSubmitted?: string | null;
  lastDownloaded?: string | null;
  isPending?: boolean | null;
  isSitemapsIndex?: boolean | null;
  type?: string | null;
  errors?: string | number | null;
  warnings?: string | number | null;
  contents?: { type?: string | null; submitted?: string | null; indexed?: string | null }[] | null;
}

async function defaultList(): Promise<GscSitemapApi[]> {
  const auth = new google.auth.JWT(
    getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    undefined,
    getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/webmasters.readonly"]
  );
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const response = await searchconsole.sitemaps.list({ siteUrl: getEnv("GSC_SITE_URL") });
  return response.data.sitemap ?? [];
}

// Convierte el contador de la API (cadena int64) a entero; lo ausente o ilegible cuenta como 0.
export function parseCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function collectGscSitemaps(
  deps: { list?: () => Promise<GscSitemapApi[]>; now?: Date } = {}
): Promise<{ saved: number }> {
  const list = deps.list ?? defaultList;
  const sitemaps = await list();
  const checkedAt = deps.now ?? new Date();

  let saved = 0;
  for (const s of sitemaps) {
    // Sin path no hay a qué asociar el estado: se ignora.
    if (!s.path) continue;
    await prisma.gscSitemapStatus.create({
      data: {
        path: s.path,
        checkedAt,
        lastSubmitted: parseDate(s.lastSubmitted),
        lastDownloaded: parseDate(s.lastDownloaded),
        isPending: s.isPending ?? false,
        errors: parseCount(s.errors),
        warnings: parseCount(s.warnings),
        contents: s.contents ? (s.contents as Prisma.InputJsonValue) : undefined,
        raw: s as Prisma.InputJsonValue,
      },
    });
    saved += 1;
  }

  return { saved };
}
