// scripts/crawl-weekly.ts
// Rastreo ligero semanal (§11). Guarda en CrawlPage y muestra un resumen.
// Sale con 1 si no se pudo rastrear (robots.txt caído, sin clave, error de BD).
import { crawlSite } from "../src/crawler/weeklyCrawler";

crawlSite()
  .then(({ pages, skippedPrivate, skippedAssets, skippedByLimit }) => {
    const byStatus = new Map<string, number>();
    for (const p of pages) {
      const k = p.blockedByRobots ? "robots" : p.status === null ? "error" : String(p.status);
      byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
    }
    const summary = [...byStatus].map(([k, n]) => `${k}: ${n}`).join(", ");
    console.log(`Rastreo semanal: ${pages.length} URLs (${summary})`);
    console.log(`  privadas descartadas: ${skippedPrivate}, ficheros sin pedir: ${skippedAssets}, fuera de límite: ${skippedByLimit}`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Weekly crawl failed:", error);
    process.exit(1);
  });
