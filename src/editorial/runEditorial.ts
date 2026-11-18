// src/editorial/runEditorial.ts
// IA editorial autónoma (§16.4, B5). La lanza el puente del Mac en cada pasada:
//   1. calibración contra GSC si toca (mensual; tras una deriva, al día siguiente con
//      referencias nuevas; tras un orden invertido, a la semana);
//   2. si la calibración está bien, evalúa un artículo por pasada (nuevo, cambiado o
//      con la nota de hace más de 90 días), con tope diario;
//   3. una nota ≥ 9 pide una segunda evaluación independiente.
// Sin calibración en verde no se aprueba nada: la evaluación queda suspendida.
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { getEnv } from "../env";
import { recordAlert } from "../alerts/recordAlert";
import { getPublishedArticleUrls } from "../embeddings/fetchArticleContent";
import { extractArticle } from "./article";
import { detectHollow } from "./hollow";
import { EVALUATOR_MODEL, claudeRunner, evaluateArticle, type Runner } from "./evaluator";
import { EXCELLENT, RUBRIC_VERSION, combineExcellent, decide } from "./rubric";
import { MIN_SPEARMAN, MIN_VALIDITY_N, checkCalibration, computeOutcomes, pickReferences, spearman, type Reference, type Tier } from "./calibration";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DAILY_EVALUATIONS = 10;
export const RESCORE_DAYS = 90;
export const CALIBRATION_DAYS = 30;
export const DRIFT_RETRY_DAYS = 1;
export const INVERTED_RETRY_DAYS = 7;

export interface EditorialDeps {
  now?: Date;
  runner?: Runner;
  fetchHtml?: (url: string) => Promise<string>;
  listArticles?: () => Promise<{ slug: string; url: string }[]>;
}

/** Artículo = /blog/<categoría>/<slug>; /blog/<categoría> es una página de categoría y no se evalúa. */
export const isArticleSlug = (slug: string) => /^[a-z0-9-]+\/[a-z0-9-]+$/.test(slug);

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function defaultFetchHtml(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": "miwebdeboda-seo-agent-editorial/1.0" } });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}

/** Lo que el puente necesita saber para decidir si toca calibrar. */
export function calibrationDue(last: { status: string; createdAt: Date } | null, now: Date): boolean {
  if (!last) return true;
  const age = now.getTime() - last.createdAt.getTime();
  if (last.status === "ok") return age >= CALIBRATION_DAYS * DAY_MS;
  if (last.status === "drift") return age >= DRIFT_RETRY_DAYS * DAY_MS;
  return age >= INVERTED_RETRY_DAYS * DAY_MS;
}

/** Siguiente artículo a evaluar: nunca evaluado, luego cambiado desde su nota, luego nota de hace más de 90 días. */
export function pickNext<T extends { slug: string }>(articles: T[], latest: Map<string, { createdAt: Date }>, changedAt: Map<string, Date>, now: Date): T | null {
  const rank = (a: T) => {
    const prev = latest.get(a.slug);
    if (!prev) return 0;
    const ch = changedAt.get(a.slug);
    if (ch && ch.getTime() > prev.createdAt.getTime()) return 1;
    if (now.getTime() - prev.createdAt.getTime() >= RESCORE_DAYS * DAY_MS) return 2;
    return 3;
  };
  const ranked = articles.map((a) => ({ a, r: rank(a), t: latest.get(a.slug)?.createdAt.getTime() ?? 0 })).filter((x) => x.r < 3);
  ranked.sort((x, y) => x.r - y.r || x.t - y.t || x.a.slug.localeCompare(y.a.slug));
  return ranked[0]?.a ?? null;
}

interface Ctx {
  now: Date;
  runner: Runner;
  fetchHtml: (url: string) => Promise<string>;
  base: string;
}

/** Una evaluación completa de un artículo (las dos capas) guardada en EditorialScore. */
async function scoreArticle(ctx: Ctx, a: { slug: string; url: string }, kind: "routine" | "calibration") {
  const doc = extractArticle(await ctx.fetchHtml(a.url), ctx.base);
  const contentHash = hash(doc.text);
  const hollow = detectHollow(doc.text);
  const similar = await similarSlugs(a.slug);
  const first = await evaluateArticle({ url: a.url, doc, hollow, similar }, ctx.runner);
  let finalScore = first.score;
  let reasonExtra = "";
  if (first.score >= EXCELLENT) {
    const second = await evaluateArticle({ url: a.url, doc, hollow, similar }, ctx.runner);
    await prisma.editorialScore.create({
      data: { slug: a.slug, url: a.url, contentHash, kind: "second", rubricVersion: RUBRIC_VERSION, model: EVALUATOR_MODEL, score: second.score, finalScore: second.score, decision: "confirm", reason: "segunda evaluación de una nota ≥ 9", criteria: second.criteria as object, deterministic: hollow as object, summary: second.summary, createdAt: ctx.now },
    });
    finalScore = combineExcellent(first.score, second.score);
    reasonExtra = `; segunda evaluación ${second.score}`;
  }
  const d = decide(finalScore, first.criteria);
  await prisma.editorialScore.create({
    data: { slug: a.slug, url: a.url, contentHash, kind, rubricVersion: RUBRIC_VERSION, model: EVALUATOR_MODEL, score: first.score, finalScore, decision: d.decision, reason: d.reason + reasonExtra, criteria: first.criteria as object, deterministic: hollow as object, summary: first.summary, createdAt: ctx.now },
  });
  return { contentHash, finalScore, decision: d.decision };
}

async function similarSlugs(slug: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRaw<{ slug: string }[]>`
      SELECT b.slug FROM "seo_agent"."ArticleEmbedding" a JOIN "seo_agent"."ArticleEmbedding" b ON b.slug <> a.slug
      WHERE a.slug = ${slug} AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL
      ORDER BY a.embedding <=> b.embedding LIMIT 5`;
    return rows.map((r) => r.slug);
  } catch {
    return [];
  }
}

async function loadOutcomes(base: string, now: Date) {
  const since = new Date(now.getTime() - 90 * DAY_MS);
  const gsc = await prisma.$queryRaw<{ page: string; impressions: number; clicks: number; position: number }[]>`
    SELECT page, sum(impressions)::int AS impressions, sum(clicks)::int AS clicks,
           (sum(coalesce(position, 0) * impressions) / nullif(sum(impressions), 0))::float AS position
    FROM "seo_agent"."SearchConsolePageDaily"
    WHERE type = 'web' AND date >= ${since} AND page LIKE ${`${base}/blog/%`}
    GROUP BY page`;
  const ga = await prisma.$queryRaw<{ page: string; sessions: number; engaged: number }[]>`
    SELECT "landingPage" AS page, sum(sessions)::int AS sessions, sum("engagedSessions")::int AS engaged
    FROM "seo_agent"."AnalyticsLandingDaily"
    WHERE channel = 'Organic Search' AND date >= ${since} AND "landingPage" LIKE ${`${base}/blog/%`}
    GROUP BY "landingPage"`;
  const gaBy = new Map(ga.map((g) => [g.page, g]));
  const prefix = `${base}/blog/`;
  return computeOutcomes(
    gsc
      .filter((g) => isArticleSlug(g.page.slice(prefix.length)))
      .map((g) => ({ slug: g.page.slice(prefix.length), impressions: g.impressions, clicks: g.clicks, position: g.position ?? 0, sessions: gaBy.get(g.page)?.sessions, engagedSessions: gaBy.get(g.page)?.engaged })),
  );
}

async function runCalibration(ctx: Ctx, articles: { slug: string; url: string }[]): Promise<string> {
  const urlOf = new Map(articles.map((a) => [a.slug, a.url]));
  const last = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  const prevRefs = ((last?.references ?? []) as unknown as Reference[]).filter((r) => urlOf.has(r.slug));
  // Se reutilizan las referencias (y sus anclas) si la última calibración fue buena y siguen todas publicadas.
  const outcomes = (await loadOutcomes(ctx.base, ctx.now)).filter((o) => urlOf.has(o.slug));
  let refs: Reference[];
  if (last?.status === "ok" && prevRefs.length === (last.references as unknown[]).length && prevRefs.length > 0) {
    refs = prevRefs;
  } else {
    refs = pickReferences(outcomes).map((r) => ({ ...r, contentHash: null, anchor: null }));
  }
  if (refs.length === 0) {
    await prisma.editorialCalibration.create({ data: { status: "inverted", detail: "menos de 6 artículos con datos suficientes de GSC", references: [], createdAt: ctx.now } });
    return "calibración: sin datos suficientes de GSC";
  }

  const scores = new Map<string, number>();
  const hashes = new Map<string, string>();
  for (const r of refs) {
    const s = await scoreArticle(ctx, { slug: r.slug, url: urlOf.get(r.slug)! }, "calibration");
    scores.set(r.slug, s.finalScore);
    hashes.set(r.slug, s.contentHash);
  }
  // Si el texto de una referencia ha cambiado, su ancla ya no vale: se compara solo el orden.
  const comparable = refs.map((r) => ({ ...r, anchor: r.contentHash && r.contentHash === hashes.get(r.slug) ? r.anchor : null }));
  const check = checkCalibration(comparable, scores, await validityPairs(outcomes));
  const next: Reference[] = refs.map((r, i) => ({
    slug: r.slug,
    tier: r.tier as Tier,
    outcome: r.outcome,
    contentHash: hashes.get(r.slug) ?? null,
    anchor: comparable[i].anchor ?? scores.get(r.slug) ?? null,
  }));
  await saveCalibration(ctx.now, check.status, check.detail, next);
  return `calibración: ${check.status} (${check.detail})`;
}

/** Validez con todos los artículos que tienen nota y datos de GSC, no solo las 6 referencias. */
async function validityPairs(outcomes: { slug: string; outcome: number }[]): Promise<[number, number][]> {
  const latest = await prisma.editorialScore.findMany({
    where: { kind: { in: ["routine", "calibration"] }, slug: { in: outcomes.map((o) => o.slug) } },
    orderBy: { createdAt: "desc" },
    distinct: ["slug"],
    select: { slug: true, finalScore: true },
  });
  const scoreOf = new Map(latest.map((l) => [l.slug, l.finalScore]));
  return outcomes.filter((o) => scoreOf.has(o.slug)).map((o) => [scoreOf.get(o.slug)!, o.outcome]);
}

async function saveCalibration(now: Date, status: string, detail: string, references: Reference[]) {
  await prisma.editorialCalibration.create({ data: { status, detail, references: references as unknown as object, createdAt: now } });
  if (status === "inverted") {
    await recordAlert({
      type: "editorial-calibration-inverted",
      subject: "IA editorial suspendida: sus notas van al revés que los resultados de GSC",
      body: `${detail}. La evaluación automática queda suspendida; se reintenta con referencias nuevas en ${INVERTED_RETRY_DAYS} días.`,
    }).catch(() => {});
  }
}

export async function runEditorial(deps: EditorialDeps = {}): Promise<string[]> {
  const now = deps.now ?? new Date();
  const ctx: Ctx = { now, runner: deps.runner ?? claudeRunner, fetchHtml: deps.fetchHtml ?? defaultFetchHtml, base: getEnv("SITE_BASE_URL").replace(/\/$/, "") };
  const notes: string[] = [];
  const articles = (await (deps.listArticles ?? (() => getPublishedArticleUrls({ baseUrl: ctx.base })))()).filter((a) => isArticleSlug(a.slug));
  if (articles.length === 0) return notes;

  const calibration = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  if (calibrationDue(calibration, now)) {
    notes.push(await runCalibration(ctx, articles));
    return notes; // una pasada, un trabajo: la evaluación rutinaria sigue en la siguiente
  }
  if (calibration?.status !== "ok") {
    notes.push(`editorial suspendida (calibración ${calibration?.status ?? "pendiente"})`);
    return notes;
  }
  // La validez se vuelve a mirar en cada pasada con las notas nuevas: no hace falta esperar al mes.
  const validity = await validityPairs((await loadOutcomes(ctx.base, now)).filter((o) => articles.some((a) => a.slug === o.slug)));
  if (validity.length >= MIN_VALIDITY_N && spearman(validity) < MIN_SPEARMAN) {
    const detail = `correlación nota–GSC ${spearman(validity)} con ${validity.length} artículos`;
    await saveCalibration(now, "inverted", detail, calibration.references as unknown as Reference[]);
    notes.push(`editorial suspendida: ${detail}`);
    return notes;
  }

  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((await prisma.editorialScore.count({ where: { kind: "routine", createdAt: { gte: dayStart } } })) >= DAILY_EVALUATIONS) return notes;

  const latest = await prisma.editorialScore.findMany({
    where: { kind: { in: ["routine", "calibration"] } },
    orderBy: { createdAt: "desc" },
    distinct: ["slug"],
    select: { slug: true, createdAt: true, contentHash: true },
  });
  const latestBy = new Map(latest.map((l) => [l.slug, l]));
  // El embedding semanal se regenera solo cuando cambia el texto publicado: su fecha dice si hay versión nueva.
  const changed = new Map((await prisma.articleEmbedding.findMany({ select: { slug: true, updatedAt: true } })).map((e) => [e.slug, e.updatedAt]));
  const a = pickNext(articles, latestBy, changed, now);
  if (a) {
    const s = await scoreArticle(ctx, a, "routine");
    notes.push(`editorial: ${a.slug} ${s.finalScore} (${s.decision})`);
  }
  return notes;
}
