// scripts/seo-brake-gate.ts
// seo-brake-gate (anexo C.4). Pensado para la CI de wedding-invite-2 con el rol
// seo_ci: en un PR falla con el freno o el interruptor activos; en el push a
// main revisa los asuntos de todo el rango desde el último DeployEvent y solo
// bloquea si hay commits seo(…). Sale con 0 (adelante) o 1 (no desplegar).
//   tsx scripts/seo-brake-gate.ts pr
//   git log --format=%s <desde>..HEAD | tsx scripts/seo-brake-gate.ts push
//   tsx scripts/seo-brake-gate.ts last-deploy   (imprime el último commitSha desplegado)
import { readFileSync } from "node:fs";
import { prisma } from "../src/db";
import { gateDecision } from "../src/brake/brake";
import { readControl } from "../src/brake/control";
import { recordAlert } from "../src/alerts/recordAlert";

async function main(): Promise<number> {
  const mode = process.argv[2];
  try {
    if (mode === "last-deploy") {
      const last = await prisma.deployEvent.findFirst({ orderBy: { deployedAt: "desc" } });
      if (last) console.log(last.commitSha);
      return 0;
    }
    if (mode !== "pr" && mode !== "push") {
      console.error("Uso: seo-brake-gate.ts pr | push (asuntos por stdin) | last-deploy");
      return 1;
    }
    const subjects = mode === "push" ? readFileSync(0, "utf8").split("\n").filter((l) => l.trim()) : [];
    const d = gateDecision(mode, subjects, await readControl());
    if (d.allow) {
      console.log(d.seoChangeIds.length ? `seo-brake-gate: adelante (${d.seoChangeIds.join(", ")})` : "seo-brake-gate: adelante");
      return 0;
    }
    console.error(`seo-brake-gate: NO se despliega: ${d.reason}`);
    try {
      await recordAlert({ type: "seo-brake-gate-blocked", subject: "seo-brake-gate ha parado un despliegue", body: `${d.reason}. Cambios SEO del rango: ${d.seoChangeIds.join(", ") || "ninguno"}.` });
    } catch {
      // sin BD: el fallo del job ya avisa
    }
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
