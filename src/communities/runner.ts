// src/communities/runner.ts
// Un tick del agente de comunidades: limpia lo caducado, lee las fuentes listas, guarda las
// candidatas (minimizadas y sin repetir hilos) y, una vez al día desde las 07:00 de Madrid,
// redacta las tarjetas con una sola llamada al modelo. Nunca publica nada.
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { Runner } from "../editorial/evaluator";
import { EditorialDeferred } from "../editorial/modelErrors";
import { DAILY_CARDS, RETENTION_DAYS, campaignUrl, madrid, minimize, scorePost, selectCards, threadKey } from "./core";
import { DRAFT_SYSTEM, buildDraftPrompt, draftSchema, validateDrafts, type DraftInput } from "./draft";
import { SourceError, type Source } from "./sources";

export interface TickDeps {
  db: PrismaClient;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  sources: Source[];
  key: Buffer;
  /** Runner con presupuesto (budgetedRunner(..., "background")). */
  runner: Runner;
  /** Día (Madrid) de la última redacción, para no gastar más de una llamada al día. */
  lastDraftDay: () => string | null;
  setLastDraftDay: (day: string) => void;
  log?: (m: string) => void;
}

export interface TickResult { off: boolean; fetched: Record<string, number | string>; stored: number; cards: number; deferred?: string }

const DAY = 86_400_000;

export async function retention(db: PrismaClient, now: Date): Promise<void> {
  // Las huellas de lo que caduca sin tratar quedan como «expired»: el hilo no vuelve.
  await db.$executeRaw`UPDATE "seo_agent"."CommunityDedup" d SET "disposition" = 'expired' FROM "seo_agent"."CommunityPost" p
    WHERE p."expiresAt" < ${now} AND d."sourceKind" = p."sourceKind" AND d."threadKey" = p."threadKey" AND d."disposition" = 'seen'`;
  await db.communityPost.deleteMany({ where: { expiresAt: { lt: now } } });
  const cutoff = madrid(new Date(now.getTime() - 396 * DAY)).day;
  await db.communityDailyResult.deleteMany({ where: { dayMadrid: { lt: cutoff } } });
}

export async function tick(d: TickDeps): Promise<TickResult> {
  const now = d.now();
  const res: TickResult = { off: false, fetched: {}, stored: 0, cards: 0 };
  await retention(d.db, now); // también con el interruptor apagado
  const control = await d.db.communityControl.findUnique({ where: { id: "global" } });
  if (!control?.enabled) return { ...res, off: true };

  const rows = await d.db.communitySource.findMany();
  for (const src of d.sources) {
    const row = rows.find((r) => r.kind === src.kind);
    if (!row?.enabled || !src.configured(d.env)) continue;
    // Lo que aún no funciona se reintenta cada 2 h, para arrancar pronto en cuanto se conecte.
    const every = row.status === "ready" ? src.everyMs : Math.min(src.everyMs, 2 * 3_600_000);
    if (row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() < every) continue;
    await d.db.communitySource.update({ where: { kind: src.kind }, data: { lastAttemptAt: now } });
    try {
      const posts = await src.fetch(now, d.env);
      let stored = 0;
      for (const p of posts) {
        const tk = threadKey(src.kind, p.canonicalId, d.key);
        const seen = await d.db.communityDedup.findUnique({ where: { sourceKind_threadKey: { sourceKind: src.kind, threadKey: tk } } });
        if (seen) continue;
        const s = scorePost(p, now);
        await d.db.communityDedup.create({ data: { sourceKind: src.kind, threadKey: tk, disposition: "seen" } });
        if (!s.eligible) continue; // de lo descartado solo queda la huella
        await d.db.communityPost.create({
          data: { sourceKind: src.kind, threadKey: tk, openUrl: p.url, excerpt: minimize(p.context ? `${p.text} [Contexto: ${p.context.slice(0, 160)}]` : p.text), publishedAt: p.publishedAt, expiresAt: new Date(now.getTime() + RETENTION_DAYS * DAY), score: s.score, eligible: true, reason: s.reason },
        });
        stored++;
      }
      res.fetched[src.kind] = posts.length;
      res.stored += stored;
      await d.db.communitySource.update({ where: { kind: src.kind }, data: { status: "ready", lastSuccessAt: now, lastErrorCode: null } });
    } catch (e) {
      const code = e instanceof SourceError ? e.code : "error";
      res.fetched[src.kind] = code;
      await d.db.communitySource.update({ where: { kind: src.kind }, data: { status: "degraded", lastErrorCode: code } });
      d.log?.(`comunidades: ${src.kind} falló (${code})`);
    }
  }

  const { day, hour } = madrid(now);
  if (hour < 7 || d.lastDraftDay() === day) return res;
  const today = await d.db.communityCard.count({ where: { dayMadrid: day } });
  const slots = DAILY_CARDS - today;
  if (slots <= 0) return res;
  const pool = await d.db.communityPost.findMany({ where: { eligible: true, card: null, expiresAt: { gt: now } } });
  const chosen = selectCards(pool.map((p) => ({ ...p, id: p.id, sourceKind: p.sourceKind, score: p.score, detectedAt: p.detectedAt })), Math.min(slots, 20));
  if (chosen.length === 0) return res;

  const codes = new Map(chosen.map((p) => [p.id, randomUUID()]));
  const inputs: DraftInput[] = chosen.map((p) => ({ id: p.id, source: p.sourceKind, excerpt: p.excerpt, campaignUrl: campaignUrl("/invitacion-digital-boda", p.sourceKind, codes.get(p.id)!) }));
  let raw: unknown;
  try {
    raw = await d.runner({ system: DRAFT_SYSTEM, user: buildDraftPrompt(inputs), schema: draftSchema });
  } catch (e) {
    if (e instanceof EditorialDeferred) return { ...res, deferred: e.message };
    throw e;
  }
  d.setLastDraftDay(day);
  const drafts = validateDrafts(raw, inputs).slice(0, slots);
  const ok = new Set(drafts.map((x) => x.id));
  for (const x of drafts) {
    const p = chosen.find((c) => c.id === x.id)!;
    await d.db.communityCard.create({ data: { postId: p.id, dayMadrid: day, draft: x.text, mentionsSite: x.mentionsSite, campaignCode: codes.get(p.id)!, expiresAt: p.expiresAt } });
    await d.db.communityDailyResult.upsert({ where: { dayMadrid_sourceKind: { dayMadrid: day, sourceKind: p.sourceKind } }, create: { dayMadrid: day, sourceKind: p.sourceKind, selected: 1 }, update: { selected: { increment: 1 } } });
  }
  // Lo que el modelo rechaza o no supera la validación no se vuelve a proponer.
  const rejected = chosen.filter((c) => !ok.has(c.id)).map((c) => c.id);
  if (rejected.length) await d.db.communityPost.updateMany({ where: { id: { in: rejected } }, data: { eligible: false, reason: "rechazada_redaccion" } });
  res.cards = drafts.length;
  return res;
}
