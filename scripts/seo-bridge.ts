// scripts/seo-bridge.ts
// Puente seo-agent → Órbita (fase 3, solo propuestas). Lo lanza el LaunchAgent
// com.miwebdeboda.seo-bridge. `--dry-run` enseña qué haría sin escribir nada.
import { prisma } from "../src/db";
import { runBridge } from "../src/bridge/runBridge";
import { recordAlert } from "../src/alerts/recordAlert";
import { detectRegressions, runReverts } from "../src/revert/runRevert";
import { runGithubJobs } from "../src/githubJobs/runGithubJobs";

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const r = await runBridge({ dryRun });
    console.log(
      `${new Date().toISOString()} puente${dryRun ? " (simulación)" : ""}: ${r.reconciled} reconciliadas, ${r.closed} cerradas, ` +
        `${r.expired} caducadas, ${r.created} creadas, ${r.adopted} adoptadas, ${r.rejected} rechazadas`,
    );
    if (dryRun) for (const p of r.planned) console.log(`  crearía: ${p}`);
    if (!dryRun) {
      // Sonda de los cambios SEO desplegados y reversiones deterministas (§15.3): fallan aparte del puente.
      try {
        const opened = await detectRegressions();
        const notes = await runReverts();
        if (opened || notes.length) console.log(`  regresiones: ${opened} nuevas; ${notes.join("; ") || "sin reversiones"}`);
      } catch (error) {
        console.error("reversiones SEO:", error);
        await recordAlert({ type: "seo-revert-failed", subject: "La sonda o la reversión SEO ha fallado", body: String(error).slice(0, 1000) }).catch(() => {});
      }
      // Trabajos con escritura en GitHub (Tier 1, sincronización semanal): con el gh del Mac, sin PAT.
      try {
        const notes = await runGithubJobs();
        if (notes.length) console.log(`  github: ${notes.join("; ")}`);
      } catch (error) {
        console.error("trabajos de GitHub:", error);
        await recordAlert({ type: "seo-github-jobs-failed", subject: "Los trabajos SEO de GitHub han fallado", body: String(error).slice(0, 1000) }).catch(() => {});
      }
    }
    return 0;
  } catch (error) {
    console.error("seo-bridge failed:", error);
    try {
      await prisma.workflowHeartbeat.upsert({
        where: { workflowName: "seo-bridge" },
        create: { workflowName: "seo-bridge", lastStatus: "failed" },
        update: { lastRunAt: new Date(), lastStatus: "failed" },
      });
      await recordAlert({ type: "seo-bridge-failed", subject: "El puente SEO con Órbita ha fallado", body: String(error).slice(0, 1000) });
    } catch {
      // sin BD no hay dónde avisar; queda el registro del LaunchAgent
    }
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
