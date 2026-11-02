// scripts/collect-gsc-sitemaps.ts
import { collectGscSitemaps } from "../src/collectors/gscSitemapCollector";

collectGscSitemaps()
  .then(({ saved }) => {
    console.log(`Sitemaps GSC: ${saved} estados guardados`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("GSC sitemap collector failed:", error);
    process.exit(1);
  });
