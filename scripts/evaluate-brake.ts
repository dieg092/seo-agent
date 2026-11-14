// scripts/evaluate-brake.ts
// Freno automático (§14): lo lanza la recogida diaria después de priorizar.
import { prisma } from "../src/db";
import { evaluateAndApply } from "../src/brake/control";

evaluateAndApply()
  .then((d) => {
    console.log(d.trip ? `Freno SEO activado: ${d.reasons.join("; ")}` : "Freno SEO: sin disparadores");
    if (d.pauseLanes.length) console.log(`Carriles en pausa por calidad de datos: ${d.pauseLanes.join(", ")}`);
    return 0;
  })
  .catch((error) => {
    console.error("evaluate-brake failed:", error);
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  });
