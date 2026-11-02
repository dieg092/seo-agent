// scripts/collect-analytics.ts
import { collectAnalytics } from "../src/collectors/analyticsCollector";
import { collectAnalyticsLanding } from "../src/collectors/analyticsLandingCollector";

async function main(): Promise<number> {
  let exitCode = 0;

  try {
    const { inserted } = await collectAnalytics();
    console.log(`Analytics: ${inserted} filas insertadas/actualizadas`);
  } catch (error) {
    console.error("Analytics collector failed:", error);
    exitCode = 1;
  }

  // La recogida por landing necesita la tabla AnalyticsLandingDaily (migración B2) y
  // SEO_PRIVATE_URL_KEY (B8). Hasta que el workflow pase la clave (Task 9), se omite
  // para no cambiar el comportamiento del paso diario.
  if (!process.env.SEO_PRIVATE_URL_KEY) {
    console.log("Analytics por landing: omitido, falta SEO_PRIVATE_URL_KEY");
    return exitCode;
  }

  try {
    const r = await collectAnalyticsLanding();
    console.log(
      `Analytics por landing: ${r.saved} filas insertadas/actualizadas, ` +
        `${r.privateLandings} landings privadas redactadas, métrica ${r.metric}`
    );
  } catch (error) {
    console.error("Analytics landing collector failed:", error);
    exitCode = 1;
  }

  return exitCode;
}

main().then((code) => process.exit(code));
