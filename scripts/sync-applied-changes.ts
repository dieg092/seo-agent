import { prisma } from "../src/db";
import { getPullRequestStatus, getPullRequestStatusWithHeaders } from "../src/tier1/github";
import { checkPatExpiration } from "../src/alerts/checkPatExpiration";
import { recordAlert } from "../src/alerts/recordAlert";

async function main() {
  const openChanges = await prisma.appliedChange.findMany({ where: { status: "open" } });

  let updated = 0;
  for (const change of openChanges) {
    const status = await getPullRequestStatus({ prNumber: change.prNumber });
    if (status !== "open") {
      await prisma.appliedChange.update({ where: { id: change.id }, data: { status } });
      updated += 1;
    }
  }

  if (openChanges.length > 0) {
    try {
      const { headers } = await getPullRequestStatusWithHeaders({ prNumber: openChanges[0].prNumber });
      const expiration = checkPatExpiration(headers);
      if (expiration && expiration.daysRemaining < 30) {
        await recordAlert({
          type: "pat-expiring",
          subject: `El PAT de GitHub caduca en ${expiration.daysRemaining} días`,
          body: `WEDDING_INVITE_2_PAT caduca en ${expiration.daysRemaining} días. Genera un nuevo fine-grained PAT (mismo scope: Contents + Pull requests, read/write, solo wedding-invite-2) y actualiza el secreto WEDDING_INVITE_2_PAT en GitHub Actions antes de que caduque, o todos los workflows de PRs empezarán a fallar.`,
        });
      }
    } catch (error) {
      console.error("No se pudo comprobar la caducidad del PAT (no bloqueante):", error);
    }
  }

  console.log(`Sync: ${openChanges.length} PRs revisados, ${updated} actualizados`);
}

main().catch((error) => {
  console.error("Sync applied changes failed:", error);
  process.exit(1);
});
