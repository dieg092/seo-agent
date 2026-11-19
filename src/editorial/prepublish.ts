// src/editorial/prepublish.ts
// Paso de la revisión previa (ver scheduled.ts): una evaluación por pasada, del artículo programado
// más próximo que aún no tenga nota con su texto actual y la configuración actual. Va con el
// presupuesto de fondo, después de la batería y antes de la evaluación rutinaria de lo publicado.
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { EVALUATOR_MODEL, type Runner } from "./evaluator";
import { editorialConfigKey, scoreVersion, type VersionScore } from "./paired";
import { APPROVE_MIN, CRITERION_FLOOR, CRITERION_KEYS, RUBRIC_VERSION, type CriterionKey } from "./rubric";
import { PREPUBLISH_MIN_LEAD_DAYS, daysUntil, type ScheduledArticle } from "./scheduled";

/** Clave de la revisión: el texto y la configuración que decide (si cambia algo, se revisa otra vez). */
export const prepublishKey = (md: string) => createHash("sha256").update(`${editorialConfigKey()}|${md}`).digest("hex");

/** Aprueba con nota ≥ 7 y ningún criterio por debajo de 4 en ninguna evaluación; si no, el motivo concreto. */
export function prepublishDecision(v: VersionScore): { approve: boolean; reason: string; weakest: CriterionKey[] } {
  const minOf = (k: CriterionKey) => Math.min(...v.evals.map((e) => e.criteria[k].score));
  const low = CRITERION_KEYS.filter((k) => minOf(k) < CRITERION_FLOOR);
  const weakest = (low.length ? low : [...CRITERION_KEYS].sort((a, b) => minOf(a) - minOf(b))).slice(0, 3);
  const notes = weakest
    .map((k) => {
      const e = [...v.evals].sort((x, y) => x.criteria[k].score - y.criteria[k].score)[0];
      const n = e.criteria[k].note.replace(/\s+/g, " ").trim().slice(0, 90);
      return n ? `${k}: ${n}` : k;
    })
    .join("; ");
  if (low.length) return { approve: false, reason: `criterios por debajo de ${CRITERION_FLOOR}: ${low.join(", ")} — qué falla: ${notes}`, weakest };
  if (v.score < APPROVE_MIN) return { approve: false, reason: `nota ${v.score} < ${APPROVE_MIN} — qué falla: ${notes}`, weakest };
  return { approve: true, reason: `aprobado (${v.score})`, weakest };
}

/** Evalúa el siguiente programado sin revisar. Devuelve una nota o "" si no queda ninguno. */
export async function prepublishStep(scheduled: (ScheduledArticle & { md: string })[], runner: Runner, siteBase: string, now: Date): Promise<string> {
  for (const a of scheduled) {
    // Con menos margen ya no se abriría corrección: no se gasta la llamada (ya publicado, lo evalúa la rutina).
    if (daysUntil(a.publishedAt, now) < PREPUBLISH_MIN_LEAD_DAYS) continue;
    const contentHash = prepublishKey(a.md);
    if (await prisma.editorialScore.findFirst({ where: { slug: a.slug, kind: "prepublish", contentHash }, select: { id: true } })) continue;
    const v = await scoreVersion({ url: a.url, md: a.md, siteBase, runner }, "head");
    const d = prepublishDecision(v);
    const worst = [...v.evals].sort((x, y) => x.score - y.score)[0];
    await prisma.editorialScore.create({
      data: {
        slug: a.slug,
        url: a.url,
        contentHash,
        kind: "prepublish",
        rubricVersion: RUBRIC_VERSION,
        model: EVALUATOR_MODEL,
        score: worst.score,
        finalScore: v.score,
        decision: d.approve ? "approve" : "block",
        reason: d.reason,
        criteria: worst.criteria as object,
        deterministic: { evals: v.evals.map((e) => e.score), publishedAt: a.publishedAt },
        summary: worst.summary,
        createdAt: now,
      },
    });
    return `revisión previa: ${a.slug} (sale el ${a.publishedAt}, en ${daysUntil(a.publishedAt, now)} días) ${v.score} ${d.approve ? "aprobado" : "a corregir"}`;
  }
  return "";
}
