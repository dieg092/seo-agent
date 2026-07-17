// scripts/collect-analytics.ts
import { collectAnalytics } from "../src/collectors/analyticsCollector";

collectAnalytics()
  .then(({ inserted }) => {
    console.log(`Analytics: ${inserted} filas insertadas/actualizadas`);
    process.exit(0);
  })
  .catch((error) => {
    console.error("Analytics collector failed:", error);
    process.exit(1);
  });
