// scripts/collect-funnel.ts
// Embudo orgánico de la app (vista seo_funnel_daily) → FunnelOrganicDaily.
// Necesita APP_FUNNEL_DATABASE_URL (rol de solo lectura app_funnel_reader).
import { collectFunnelOrganic } from "../src/collectors/funnelOrganicCollector";
import { prisma } from "../src/db";

async function main(): Promise<number> {
  try {
    const r = await collectFunnelOrganic();
    console.log(
      `Embudo orgánico ${r.from}..${r.to}: ${r.saved} filas guardadas, ${r.removed} borradas, ` +
        `${r.unknownLanding} sin página de entrada`
    );
    return 0;
  } catch (error) {
    console.error("Funnel collector failed:", error);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
