// src/graduation/measureImpact.ts
import { prisma } from "../db";
import { getEnv } from "../env";
import { computeOutcome } from "./computeOutcome";
import { openPullRequestWithFileChange, getExistingFileSha } from "../tier1/github";
import { recordAlert } from "../alerts/recordAlert";

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const GRADUATION_THRESHOLD = 10;

async function sumClicksSiteWide(start: Date, end: Date): Promise<number> {
  const rows = await prisma.searchConsoleSnapshot.findMany({
    where: { date: { gte: start, lt: end } },
    select: { clicks: true },
  });
  return rows.reduce((sum, r) => sum + r.clicks, 0);
}

async function sumClicksForPage(page: string, start: Date, end: Date): Promise<number> {
  const rows = await prisma.searchConsoleSnapshot.findMany({
    where: { page, date: { gte: start, lt: end } },
    select: { clicks: true },
  });
  return rows.reduce((sum, r) => sum + r.clicks, 0);
}

export async function measureAppliedChanges(deps: {
  openPr?: typeof openPullRequestWithFileChange;
  getExistingFileSha?: typeof getExistingFileSha;
  alert?: typeof recordAlert;
} = {}): Promise<{ measured: number; graduated: string[]; revoked: string[] }> {
  const openPr = deps.openPr ?? openPullRequestWithFileChange;
  const getShaFn = deps.getExistingFileSha ?? getExistingFileSha;
  const alert = deps.alert ?? recordAlert;

  const dispatchAlert = async (type: string, subject: string, body: string) => {
    try {
      await alert({ type, subject, body });
    } catch (error) {
      console.error("No se pudo registrar la alerta (no bloqueante):", error);
    }
  };

  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);

  const candidates = await prisma.appliedChange.findMany({
    where: { status: "merged", updatedAt: { lte: cutoff } },
  });

  let measured = 0;
  const graduated: string[] = [];
  const revoked: string[] = [];

  for (const change of candidates) {
    const already = await prisma.impactMeasurement.findUnique({ where: { appliedChangeId: change.id } });
    if (already) continue;

    const mergedAt = change.updatedAt;
    let before: number;
    let after: number;

    if (change.findingType === "internal-link-suggestion") {
      const opportunity = await prisma.opportunity.findUnique({ where: { stableKey: change.opportunityStableKey } });
      const detail = opportunity?.detail as { sourceSlug?: string } | null;
      if (!detail?.sourceSlug) continue;
      const baseUrl = getEnv("SITE_BASE_URL");
      const page = `${baseUrl}/blog/${detail.sourceSlug}`;
      before = await sumClicksForPage(page, new Date(mergedAt.getTime() - WINDOW_MS), mergedAt);
      after = await sumClicksForPage(page, mergedAt, new Date(mergedAt.getTime() + WINDOW_MS));
    } else {
      before = await sumClicksSiteWide(new Date(mergedAt.getTime() - WINDOW_MS), mergedAt);
      after = await sumClicksSiteWide(mergedAt, new Date(mergedAt.getTime() + WINDOW_MS));
    }

    const outcome = computeOutcome(before, after);

    await prisma.impactMeasurement.create({
      data: {
        appliedChangeId: change.id,
        findingType: change.findingType,
        outcome,
        beforeMetric: before,
        afterMetric: after,
      },
    });
    measured += 1;

    const record = await prisma.graduationRecord.findUnique({ where: { findingType: change.findingType } });

    if (outcome === "negative") {
      if (record?.autoMergeEligible) {
        revoked.push(change.findingType);
        await dispatchAlert(
          "revoked",
          `Graduación revocada: ${change.findingType}`,
          `El cambio ${change.prUrl} (findingType: ${change.findingType}) mostró un impacto negativo tras el merge. Se revoca autoMergeEligible para este tipo de hallazgo — volverá a necesitar 10 instancias limpias consecutivas.`
        );
      }
      await prisma.graduationRecord.upsert({
        where: { findingType: change.findingType },
        create: { findingType: change.findingType, consecutiveGood: 0, autoMergeEligible: false },
        update: { consecutiveGood: 0, autoMergeEligible: false },
      });

      if (change.status === "merged") {
        if (change.filePath && change.previousContent !== null) {
          try {
            const existingSha = await getShaFn({ filePath: change.filePath });
            const branchName = `seo-agent/revert-${change.prNumber}-${Date.now()}`;
            const revertPr = await openPr({
              filePath: change.filePath,
              newContent: change.previousContent,
              branchName,
              commitMessage: `revert: deshacer cambio de ${change.prUrl} (impacto negativo detectado)`,
              prTitle: `[SEO Agent] Revertir PR #${change.prNumber} — impacto negativo detectado`,
              prBody: `El cambio mergeado en ${change.prUrl} (findingType: ${change.findingType}) mostró una caída de clicks de al menos el 15% en las 2 semanas posteriores al merge, comparado con las 2 semanas previas.\n\nEste PR restaura el contenido anterior. Revisa antes de mergear — el sistema nunca mergea una reversión automáticamente.`,
              existingFileSha: existingSha,
            } as Parameters<typeof openPullRequestWithFileChange>[0]);

            await prisma.appliedChange.create({
              data: {
                opportunityStableKey: change.opportunityStableKey,
                findingType: "revert",
                prUrl: revertPr.prUrl,
                prNumber: revertPr.prNumber,
                status: "open",
                filePath: change.filePath,
                revertsAppliedChangeId: change.id,
              },
            });

            await dispatchAlert(
              "negative-impact",
              `Impacto negativo detectado — PR de reversión abierto`,
              `El cambio ${change.prUrl} (findingType: ${change.findingType}) mostró impacto negativo. Se abrió un PR de reversión: ${revertPr.prUrl}. Revísalo y decide si mergearlo — el sistema nunca lo mergea solo.`
            );
          } catch (error) {
            console.error("No se pudo abrir el PR de reversión (no bloqueante):", error);
            await dispatchAlert(
              "revert-manual-needed",
              `Impacto negativo detectado — reversión manual necesaria`,
              `El cambio ${change.prUrl} (findingType: ${change.findingType}) mostró impacto negativo, pero no se pudo abrir el PR de reversión automáticamente (${error instanceof Error ? error.message : error}). Revisión y reversión manual necesarias.`
            );
          }
        } else {
          await dispatchAlert(
            "revert-manual-needed",
            `Impacto negativo detectado — reversión manual necesaria`,
            `El cambio ${change.prUrl} (findingType: ${change.findingType}) mostró impacto negativo, pero no tiene contenido previo capturado (cambio de una fase anterior a Fase 6). Se requiere reversión manual necesaria.`
          );
        }
      }
    } else {
      const newCount = (record?.consecutiveGood ?? 0) + 1;
      const nowEligible = newCount >= GRADUATION_THRESHOLD;
      await prisma.graduationRecord.upsert({
        where: { findingType: change.findingType },
        create: { findingType: change.findingType, consecutiveGood: newCount, autoMergeEligible: nowEligible },
        update: { consecutiveGood: newCount, autoMergeEligible: nowEligible },
      });
      if (nowEligible && !record?.autoMergeEligible) {
        graduated.push(change.findingType);
        await dispatchAlert(
          "graduated",
          `Graduación conseguida: ${change.findingType}`,
          `${change.findingType} ha completado 10 instancias consecutivas sin impacto negativo. A partir de ahora, los PRs de este tipo se auto-mergean sin esperar revisión.`
        );
      }
    }
  }

  return { measured, graduated, revoked };
}
