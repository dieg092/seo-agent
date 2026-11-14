// scripts/record-deploy.ts
// Registra un despliegue de producción (DeployEvent, §13). Lo lanza la CI de
// wedding-invite-2 después de desplegar, con los asuntos del rango por stdin:
//   git log --format=%s <desde>..HEAD | tsx scripts/record-deploy.ts <sha> <runUrl>
import { readFileSync } from "node:fs";
import { prisma } from "../src/db";
import { seoChangeIds } from "../src/brake/brake";

async function main(): Promise<number> {
  const [sha, runUrl] = process.argv.slice(2);
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    console.error("Uso: record-deploy.ts <commitSha> [runUrl] (asuntos del rango por stdin)");
    return 1;
  }
  const subjects = process.stdin.isTTY ? [] : readFileSync(0, "utf8").split("\n");
  const ids = seoChangeIds(subjects);
  try {
    await prisma.deployEvent.upsert({
      where: { commitSha: sha },
      create: { commitSha: sha, runUrl: runUrl ?? null, seoChangeIds: ids },
      update: { runUrl: runUrl ?? null, seoChangeIds: ids },
    });
    console.log(`DeployEvent ${sha.slice(0, 8)}${ids.length ? ` con ${ids.join(", ")}` : ""}`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
