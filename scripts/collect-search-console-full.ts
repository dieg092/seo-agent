// scripts/collect-search-console-full.ts
import { collectSearchConsoleFull } from "../src/collectors/searchConsoleFullCollector";

collectSearchConsoleFull()
  .then((r) => {
    console.log(
      `GSC completo: ${r.pageDaily} totales por página, ${r.queryRows} consultas image/video, ` +
        `${r.segmentRows} segmentos, ${r.privateSeen} URLs privadas vistas, ${r.capped} días con tope, ` +
        `${r.failed} peticiones fallidas`
    );
    process.exit(r.failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("GSC full collector failed:", error);
    process.exit(1);
  });
