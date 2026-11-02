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

  // La recogida por landing necesita SEO_PRIVATE_URL_KEY, que el workflow diario ya
  // pasa. Si falta, no se guarda nada y el paso sale en rojo para que se note, pero
  // los totales de arriba ya se han guardado.
  if (!process.env.SEO_PRIVATE_URL_KEY) {
    console.error("Analytics por landing: falta SEO_PRIVATE_URL_KEY, no se guarda nada");
    return 1;
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
