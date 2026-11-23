// scripts/communities-tick.ts — LaunchAgent com.miwebdeboda.comunidades (cada 30 min).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db";
import { budgetedRunner } from "../src/editorial/budget";
import { claudeRunner } from "../src/editorial/evaluator";
import { recordAlert } from "../src/alerts/recordAlert";
import { hmacKey } from "../src/communities/core";
import { tick } from "../src/communities/runner";
import { allSources } from "../src/communities/accounts";

const DIR = join(homedir(), ".comunidades");
const LOCK = join(DIR, "lock");
const STATE = join(DIR, "state.json");

function readState(): { lastDraftDay?: string } {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; }
}

/** Como mucho un aviso de cada tipo al día (el tick corre cada 30 min). */
async function alertDaily(type: string, subject: string, body: string) {
  const recent = await prisma.alert.findFirst({ where: { type, createdAt: { gt: new Date(Date.now() - 24 * 3_600_000) } } });
  if (!recent) await recordAlert({ type, subject, body });
}

async function beat(status: string) {
  await prisma.workflowHeartbeat.upsert({ where: { workflowName: "comunidades" }, create: { workflowName: "comunidades", lastStatus: status }, update: { lastRunAt: new Date(), lastStatus: status } });
}

async function main() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8"));
    try { process.kill(pid, 0); console.log("comunidades: ya hay un tick en marcha"); return; } catch { /* lock huérfano */ }
  }
  writeFileSync(LOCK, String(process.pid));
  try {
    const r = await tick({
      db: prisma,
      now: () => new Date(),
      env: process.env,
      sources: allSources(prisma),
      key: hmacKey(),
      runner: budgetedRunner(claudeRunner, "community"),
      lastDraftDay: () => readState().lastDraftDay ?? null,
      setLastDraftDay: (day) => writeFileSync(STATE, JSON.stringify({ ...readState(), lastDraftDay: day })),
      log: console.log,
    });
    // Una fuente que funcionaba y lleva más de 2 días fallando: aviso (sin contenido de terceros).
    const broken = await prisma.communitySource.findMany({ where: { enabled: true, status: "degraded", lastSuccessAt: { lt: new Date(Date.now() - 48 * 3_600_000) } } });
    for (const s of broken) {
      await alertDaily(`communities-source-${s.kind}`, `Comunidades: la fuente ${s.kind} lleva más de 2 días fallando`, `Último error: ${s.lastErrorCode ?? "desconocido"}. Última lectura buena: ${s.lastSuccessAt?.toISOString()}.`);
    }
    await beat("success");
    console.log(`comunidades: ${r.off ? "apagado" : `leído ${JSON.stringify(r.fetched)}, ${r.stored} candidatas, ${r.cards} tarjetas${r.deferred ? `, aplazado: ${r.deferred}` : ""}`}`);
  } finally {
    rmSync(LOCK, { force: true });
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error("comunidades falló:", e instanceof Error ? e.message : e);
  try {
    await beat("failure");
    await alertDaily("communities-failure", "El agente de comunidades ha fallado", "El tick de comunidades terminó con error. Ver ~/Library/Logs/comunidades.log.");
  } catch {}
  process.exit(1);
});
