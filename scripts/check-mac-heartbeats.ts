// scripts/check-mac-heartbeats.ts
// Lo ejecuta self-health-watchdog (GitHub Actions) cada día: comprueba DESDE FUERA que los procesos
// del Mac siguen latiendo. Si el Mac se apaga o el supervisor de autorreparación se cuelga, nada del
// Mac puede avisar; esto sí. Avisa (BD + Telegram) y sale con 0 para no duplicar el aviso de healthchecks.
import { prisma } from "../src/db";
import { recordAlert } from "../src/alerts/recordAlert";

export const MAC_LIMITS_H: Record<string, number> = { "seo-repair": 3, "seo-bridge": 3, "seo-tick": 3 };

export function staleOnes(rows: { workflowName: string; lastRunAt: Date }[], now: Date): { name: string; hours: number }[] {
  const out: { name: string; hours: number }[] = [];
  for (const [name, limit] of Object.entries(MAC_LIMITS_H)) {
    const r = rows.find((x) => x.workflowName === name);
    const hours = r ? (now.getTime() - r.lastRunAt.getTime()) / 3_600_000 : Infinity;
    if (hours > limit) out.push({ name, hours });
  }
  return out;
}

async function main() {
  const now = new Date();
  const stale = staleOnes(await prisma.workflowHeartbeat.findMany(), now);
  if (!stale.length) return console.log("Mac: todos los procesos laten");
  const list = stale.map((s) => `${s.name} (${Number.isFinite(s.hours) ? `${Math.round(s.hours)} h` : "nunca"})`).join(", ");
  await recordAlert({
    type: "mac-stale",
    subject: "El Mac de seo-agent no da señales",
    body: `Sin latido: ${list}. Lo normal es que el Mac esté apagado o sin sesión. Enciéndelo e inicia sesión; los procesos arrancan solos. Si el Mac ya está encendido, ejecuta: launchctl kickstart -k gui/$(id -u)/com.miwebdeboda.seo-repair`,
  });
  console.log(`Mac sin latido: ${list}`);
}

if (require.main === module) main().finally(() => prisma.$disconnect());
