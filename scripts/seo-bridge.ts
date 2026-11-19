// scripts/seo-bridge.ts
// Puente seo-agent → Órbita (fase 3, solo propuestas). Lo lanza el LaunchAgent
// com.miwebdeboda.seo-bridge. `--dry-run` enseña qué haría sin escribir nada.
import { prisma } from "../src/db";
import { runBridge } from "../src/bridge/runBridge";
import { recordAlert } from "../src/alerts/recordAlert";
import { detectRegressions, runReverts } from "../src/revert/runRevert";
import { runGithubJobs } from "../src/githubJobs/runGithubJobs";
import { runEditorial } from "../src/editorial/runEditorial";
import { refreshEvidence } from "../src/editorial/evidenceStore";
import { advanceReverts, measureChanges, reconcileChanges } from "../src/graduation/changeLedger";
import { advancePilots, pilotReport } from "../src/editorial/pilot";

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
      // Registro de cambios A1: tarea → despliegue → medición por página y, si empeora dos veces, reversión.
      try {
        const now = new Date();
        const notes = [...(await reconcileChanges(now)), ...(await measureChanges(now)), ...(await advanceReverts(now)), ...(await advancePilots(now)), ...(await pilotReport(now))];
        if (notes.length) console.log(`  ${notes.join("; ")}`);
      } catch (error) {
        console.error("registro de cambios:", error);
        const recent = await prisma.alert.count({ where: { type: "seo-ledger-failed", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }).catch(() => 1);
        if (!recent) await recordAlert({ type: "seo-ledger-failed", subject: "El registro de cambios SEO ha fallado", body: String(error).slice(0, 1000) }).catch(() => {});
      }
      // Trabajos con escritura en GitHub (Tier 1, sincronización semanal): con el gh del Mac, sin PAT.
      try {
        const notes = await runGithubJobs();
        if (notes.length) console.log(`  github: ${notes.join("; ")}`);
      } catch (error) {
        console.error("trabajos de GitHub:", error);
        await recordAlert({ type: "seo-github-jobs-failed", subject: "Los trabajos SEO de GitHub han fallado", body: String(error).slice(0, 1000) }).catch(() => {});
      }
      // Evidencia admitida (una vez al día): las cifras que una mejora de artículo puede usar.
      try {
        const note = await refreshEvidence(new Date());
        if (note) console.log(`  ${note}`);
      } catch (error) {
        console.error("evidencia admitida:", error);
      }
      // IA editorial (§16.4): calibración con GSC y un artículo por pasada, con Claude sin herramientas.
      try {
        const notes = await runEditorial();
        if (notes.length) console.log(`  ${notes.join("; ")}`);
      } catch (error) {
        console.error("IA editorial:", error);
        // Corre cada media hora: un aviso al día como mucho.
        const recent = await prisma.alert.count({ where: { type: "seo-editorial-failed", createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } } }).catch(() => 1);
        if (!recent) await recordAlert({ type: "seo-editorial-failed", subject: "La IA editorial ha fallado", body: String(error).slice(0, 1000) }).catch(() => {});
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
