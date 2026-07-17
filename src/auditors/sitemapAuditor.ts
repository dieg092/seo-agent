import * as cheerio from "cheerio";
import { getEnv } from "../env";

const STALE_THRESHOLD_DAYS = 400; // Google re-crawls active sites well within a year; a lastmod older than this on a page still in the sitemap suggests the value isn't being refreshed.

export async function auditSitemap(deps: {
  fetchXml?: (url: string) => Promise<string>;
  baseUrl?: string;
} = {}): Promise<{ urlCount: number; staleEntries: number; errors: string[] }> {
  const baseUrl = deps.baseUrl ?? getEnv("SITE_BASE_URL");
  const fetchXml =
    deps.fetchXml ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Sitemap fetch failed: ${response.status}`);
      }
      return response.text();
    });

  const errors: string[] = [];
  let xml: string;
  try {
    xml = await fetchXml(`${baseUrl}/sitemap.xml`);
  } catch (error) {
    return { urlCount: 0, staleEntries: 0, errors: [`No se pudo obtener el sitemap: ${(error as Error).message}`] };
  }

  // Check for basic XML structure validity
  if (!xml.includes("</urlset>")) {
    errors.push("El XML del sitemap parece estar mal formado (no se encontró </urlset>)");
  }

  const $ = cheerio.load(xml, { xmlMode: true });
  const urlNodes = $("url");

  const now = Date.now();
  let staleEntries = 0;

  // Only process URL nodes if the XML structure is valid
  if (!xml.includes("</urlset>")) {
    return { urlCount: 0, staleEntries: 0, errors };
  }

  urlNodes.each((_, el) => {
    const loc = $(el).find("loc").text().trim();
    if (loc && !loc.startsWith(baseUrl)) {
      errors.push(`URL fuera de dominio en el sitemap: ${loc}`);
    }

    const lastmod = $(el).find("lastmod").text().trim();
    if (lastmod) {
      const ageMs = now - new Date(lastmod).getTime();
      if (ageMs > STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000) {
        staleEntries += 1;
      }
    }
  });

  return { urlCount: urlNodes.length, staleEntries, errors };
}
