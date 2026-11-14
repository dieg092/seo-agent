// scripts/seo-switch.ts
// Interruptor general, pausa por carril y rearme del freno SEO (§14, anexo C.6).
//   pnpm seo:switch status
//   pnpm seo:switch off|on --reason "…" [--lane content]
//   pnpm seo:switch rearm --reason "…"
import { prisma } from "../src/db";
import { readControl, rearm, setLanePaused, setSwitch } from "../src/brake/control";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const reason = arg("reason");
  const lane = arg("lane");
  try {
    if (cmd === "status") {
      const c = await prisma.seoControl.findUnique({ where: { id: "global" } });
      console.log(JSON.stringify(c ?? (await readControl()), null, 2));
      return 0;
    }
    if (!reason) {
      console.error("Falta --reason");
      return 1;
    }
    if (cmd === "rearm") await rearm(reason);
    else if ((cmd === "off" || cmd === "on") && lane) await setLanePaused(lane, cmd === "off", reason);
    else if (cmd === "off" || cmd === "on") await setSwitch(cmd === "on", reason);
    else {
      console.error("Uso: seo:switch status | off|on --reason … [--lane …] | rearm --reason …");
      return 1;
    }
    console.log(JSON.stringify(await readControl()));
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
