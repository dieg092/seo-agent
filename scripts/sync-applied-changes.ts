import { prisma } from "../src/db";
import { getPullRequestStatus } from "../src/tier1/github";

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

  console.log(`Sync: ${openChanges.length} PRs revisados, ${updated} actualizados`);
}

main().catch((error) => {
  console.error("Sync applied changes failed:", error);
  process.exit(1);
});
