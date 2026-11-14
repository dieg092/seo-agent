// src/bridge/runBridge.ts
// Una pasada del puente con Órbita (anexo C.5), fase 3: solo propuestas.
// 1. Reconciliación de las tareas abiertas. 2. Caducidad. 3. Creación con
// cupos y sin duplicados. 4. Latido. Todas las tareas de IA entran con
// «propuesta» (lo pone el CLI de Órbita): nada se ejecuta sin el fundador.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import { InvalidTransitionError, transition, type LifecycleEvent } from "../opportunity/lifecycle";
import { lifecycleData, lifecycleOf } from "../prioritization/prioritize";
import { dismissalValue, type PriorityFactors } from "../prioritization/priority";
import { buildContract, renderDescription, renderPrompt, taskTitle, validateContract, type SeoTaskContract } from "./contract";
import { expiryReason, planCreations, reconcile, type TaskStatus } from "./plan";
import { orbitaCli, type OrbitaClient } from "./orbitaCli";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const BRIDGE_LABELS = ["seo", "seo-agent"];

export interface BridgeResult {
  reconciled: number;
  closed: number;
  expired: number;
  created: number;
  adopted: number;
  rejected: number;
  planned: string[];
}

function priorityFor(lane: string, severity: string): string {
  if (lane === "urgent" || severity === "critical") return "urgent";
  if (severity === "high") return "high";
  if (severity === "medium") return "medium";
  return "low";
}

async function applyEvents(opportunityId: string, events: LifecycleEvent["type"][], now: Date): Promise<void> {
  if (events.length === 0) return;
  const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opp) return;
  let lc = lifecycleOf(opp);
  for (const type of events) {
    const event: LifecycleEvent =
      type === "task-cancelled"
        ? { type, value: opp.priorityFactors ? dismissalValue(opp.priorityFactors as unknown as PriorityFactors) : opp.businessValue }
        : ({ type } as LifecycleEvent);
    try {
      lc = transition(lc, event, now);
    } catch (e) {
      // Un evento que no aplica desde el estado actual (p. ej. task-started ya en curso) se ignora.
      if (!(e instanceof InvalidTransitionError)) throw e;
    }
  }
  await prisma.opportunity.update({ where: { id: opportunityId }, data: lifecycleData(lc) });
}

export async function runBridge(deps: { orbita?: OrbitaClient; now?: Date; dryRun?: boolean } = {}): Promise<BridgeResult> {
  const orbita = deps.orbita ?? orbitaCli;
  const now = deps.now ?? new Date();
  const dry = deps.dryRun ?? false;
  const result: BridgeResult = { reconciled: 0, closed: 0, expired: 0, created: 0, adopted: 0, rejected: 0, planned: [] };

  // 1. Reconciliación.
  const open = await prisma.seoTaskLink.findMany({ where: { closedAt: null } });
  for (const link of open) {
    const task = await orbita.get(link.orbitaTaskId);
    const status = (task ? task.status : "missing") as TaskStatus;
    const r = reconcile(status, link.taskStatus);
    result.reconciled += 1;
    if (dry) continue;
    await applyEvents(link.opportunityId, r.events, now);
    await prisma.seoTaskLink.update({
      where: { id: link.id },
      data: { taskStatus: status, lastSyncedAt: now, ...(r.close ? { closedAt: now, closeReason: r.close } : {}) },
    });
    if (r.close) result.closed += 1;
    link.taskStatus = status;
    if (r.close) link.closedAt = now;
  }

  // 2. Caducidad de lo que no ha empezado.
  for (const link of open.filter((l) => l.closedAt === null)) {
    const opp = await prisma.opportunity.findUnique({ where: { id: link.opportunityId }, select: { status: true, state: true } });
    const reason = expiryReason(link, opp, now);
    if (!reason || dry) continue;
    const text =
      reason === "resolved"
        ? "Cancelada por seo-agent: el hallazgo ya no aparece en las últimas evaluaciones."
        : "Cancelada por seo-agent: ha caducado sin empezar. Si el problema sigue, se volverá a proponer.";
    if (!(await orbita.cancelIfTodo(link.orbitaTaskId, text))) continue;
    await prisma.seoTaskLink.update({ where: { id: link.id }, data: { taskStatus: "cancelled", closedAt: now, closeReason: reason, lastSyncedAt: now } });
    // Caducada sin decisión del fundador: el hallazgo vuelve a open (no es un descarte).
    if (reason === "expired") {
      await prisma.opportunity.updateMany({ where: { id: link.opportunityId, state: "queued" }, data: { state: "open", stateChangedAt: now } });
    }
    result.expired += 1;
  }

  // 3. Creación.
  const stillOpen = await prisma.seoTaskLink.findMany({ where: { closedAt: null } });
  const recent = await prisma.seoTaskLink.findMany({ where: { createdAt: { gte: new Date(now.getTime() - WEEK_MS) } } });
  const candidates = await prisma.opportunity.findMany({
    where: { status: "open", state: "open" },
    select: { id: true, stableKey: true, findingType: true, page: true, operation: true, autonomy: true, lane: true, priorityScore: true, state: true, status: true },
  });
  const plan = planCreations(candidates, stillOpen, recent, now);
  result.planned = plan.map((c) => `${c.lane} ${c.findingType} ${c.priorityScore.toFixed(1)}`);
  if (dry) return result;

  const dir = mkdtempSync(join(tmpdir(), "seo-bridge-"));
  try {
    for (const c of plan) {
      const opp = await prisma.opportunity.findUnique({ where: { id: c.id } });
      if (!opp) continue;
      const contract: SeoTaskContract = buildContract(
        { id: opp.id, stableKey: opp.stableKey, findingType: opp.findingType, title: opp.title, detail: opp.detail, page: opp.page, operation: opp.operation, autonomy: opp.autonomy, lane: opp.lane, severity: opp.severity },
        { now, changeId: randomUUID() },
      );
      const errors = validateContract(contract);
      if (errors.length > 0) {
        result.rejected += 1;
        await recordAlert({
          type: "seo-bridge-contract-rejected",
          subject: `Contrato SEO rechazado (${opp.findingType})`,
          body: `El puente no crea la tarea del hallazgo ${opp.stableKey.slice(0, 12)}: ${errors.join(", ")}.`,
        });
        continue;
      }
      const metadataFile = join(dir, `${opp.stableKey}.json`);
      writeFileSync(metadataFile, JSON.stringify({ seo: { ...contract, stage: "proposal" } }));
      const manual = contract.operation === "manual";
      const { id, created } = await orbita.add({
        title: taskTitle(contract),
        description: renderDescription(contract),
        priority: priorityFor(opp.lane, opp.severity),
        labels: BRIDGE_LABELS,
        metadataFile,
        dedupeKey: opp.stableKey,
        aiPrompt: manual ? null : renderPrompt(contract),
      });
      await prisma.seoTaskLink.upsert({
        where: { orbitaTaskId: id },
        create: {
          opportunityId: opp.id,
          stableKey: opp.stableKey,
          orbitaTaskId: id,
          findingType: opp.findingType,
          operation: contract.operation,
          page: opp.page,
          lane: opp.lane,
          autonomy: contract.autonomy,
          contract: contract as unknown as object,
          expiresAt: new Date(contract.expiresAt),
        },
        update: { closedAt: null, closeReason: null, lastSyncedAt: now },
      });
      await applyEvents(opp.id, ["task-created"], now);
      if (created) result.created += 1;
      else result.adopted += 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 4. Latido.
  await prisma.workflowHeartbeat.upsert({
    where: { workflowName: "seo-bridge" },
    create: { workflowName: "seo-bridge", lastStatus: "ok" },
    update: { lastRunAt: now, lastStatus: "ok" },
  });
  return result;
}
