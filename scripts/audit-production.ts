// scripts/audit-production.ts
// Sonda diaria de producción (§10.7). Sale con 1 si alguna fila no está bien, para que
// el workflow lo marque en rojo. Las URLs de los fallos se muestran redactadas.
import { probeProduction } from "../src/auditors/productionProbe";
import { redactUrl } from "../src/privacy/redact";

function safeRedact(url: string): string {
  if (url.includes("<privada:")) return url;
  try {
    return redactUrl(url);
  } catch {
    return "<no-valida>";
  }
}

probeProduction()
  .then(({ results, failures }) => {
    const byKind = new Map<string, number>();
    for (const r of results) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    const summary = [...byKind].map(([kind, n]) => `${kind}: ${n}`).join(", ");
    console.log(`Sonda de producción: ${results.length} filas (${summary}), ${failures} fallos`);
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  [${r.kind}] ${safeRedact(r.url)}: ${r.reason ?? "sin motivo"}`);
    }
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error("Production probe failed:", error);
    process.exit(1);
  });
