// src/communities/tiktok.ts
// TikTok con una cuenta gratuita de Apify SOLO para comunidades (no la de colaboradores).
// Una búsqueda al día (rota entre QUERIES), vídeos de la última semana buscados desde España,
// y sus comentarios de primer nivel. Tope de gasto mensual por debajo del crédito gratis (5 $).
import type { RawPost } from "./core";
import { madrid } from "./core";
import { SourceError, type Source } from "./sources";

export const APIFY_ACTOR = "clockworks~tiktok-scraper";
export const MONTHLY_CAP_USD = 4;
/** Coste aproximado de una búsqueda (6 vídeos con filtros + 60 comentarios), para no empezar una que pase el tope. */
export const RUN_ESTIMATE_USD = 0.15;

export const QUERIES = [
  "invitaciones de boda",
  "confirmar asistencia boda",
  "invitación de boda digital",
  "organizar boda 2027",
  "lista de invitados boda",
  "save the date boda",
];

export interface TikTokCursor { month: string; spentUsd: number; next: number }

export function parseTikTokCursor(raw: string | null | undefined, now: Date): TikTokCursor {
  const month = madrid(now).day.slice(0, 7);
  let c: Partial<TikTokCursor> = {};
  try {
    c = raw ? JSON.parse(raw) : {};
  } catch {
    c = {};
  }
  // Mes nuevo: el gasto vuelve a cero; la rotación de búsquedas sigue.
  return { month, spentUsd: c.month === month ? Number(c.spentUsd) || 0 : 0, next: Number(c.next) || 0 };
}

export function canSpend(c: TikTokCursor): boolean {
  return c.spentUsd + RUN_ESTIMATE_USD <= MONTHLY_CAP_USD;
}

export function actorInput(query: string) {
  return {
    searchQueries: [query],
    searchSection: "/video",
    resultsPerPage: 6,
    videoSearchDateFilter: "PAST_WEEK",
    proxyCountryCode: "ES",
    commentsPerPost: 10,
    maxRepliesPerComment: 0,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  };
}

export interface TikTokComment { cid?: string; text?: string; createTimeISO?: string; videoWebUrl?: string; repliesToId?: string | null }

/** Señales de Latinoamérica: TikTok no da el país y la búsqueda «desde España» también trae vídeos de allí. */
const LATAM = /\b(mexico|mexicana?|cdmx|monterrey|guadalajara|morelia|puebla|tijuana|colombia|bogota|medellin|argentina|buenos aires|chile|peru|lima|ecuador|quito|venezuela|bolivia|guatemala|honduras|salvador|costa rica|panama|uruguay|paraguay|cuba|ustedes|quinceanera|xv anos|pesos|mxn)\b/;

export interface TikTokVideo { webVideoUrl?: string; text?: string; locationMeta?: { locationName?: string } | null }

/** Comentarios de primer nivel con texto → publicaciones crudas, con el texto del vídeo como contexto. */
export function postsFromComments(comments: TikTokComment[], videos: TikTokVideo[] = []): RawPost[] {
  const byUrl = new Map(videos.map((v) => [v.webVideoUrl, `${v.text ?? ""} ${v.locationMeta?.locationName ?? ""}`.trim()]));
  return comments
    .filter((c) => c.cid && c.text && c.videoWebUrl && !c.repliesToId)
    .map((c) => {
      const context = byUrl.get(c.videoWebUrl) ?? "";
      const all = `${c.text} ${context}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return { canonicalId: c.cid!, url: c.videoWebUrl!, text: c.text!, publishedAt: c.createTimeISO ? new Date(c.createTimeISO) : null, context, spain: !LATAM.test(all) };
    });
}

const API = "https://api.apify.com/v2";

async function api(http: typeof fetch, token: string, path: string, init?: RequestInit): Promise<any> {
  const r = await http(`${API}${path}`, { ...init, headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  if (r.status === 401 || r.status === 403) throw new SourceError(`apify_${r.status}`, "Apify rechaza el token");
  if (r.status === 402) throw new SourceError("apify_sin_credito", "Sin crédito en Apify");
  if (!r.ok) throw new SourceError(`apify_${r.status}`, `Apify respondió ${r.status}`);
  return r.json();
}

export function tiktokSource(deps: {
  token: () => string | null;
  store: { get: () => Promise<string | null>; set: (v: string) => Promise<void> };
  log?: (m: string) => void;
  pollMs?: number;
}): Source {
  return {
    kind: "tiktok",
    everyMs: 24 * 3_600_000,
    configured: () => Boolean(deps.token()),
    async fetch(now, _env, http = fetch) {
      const token = deps.token()!;
      const cursor = parseTikTokCursor(await deps.store.get(), now);
      if (!canSpend(cursor)) {
        deps.log?.(`comunidades: tiktok en pausa hasta fin de mes (gastado ${cursor.spentUsd.toFixed(2)} $ de ${MONTHLY_CAP_USD} $)`);
        await deps.store.set(JSON.stringify(cursor));
        return [];
      }
      const query = QUERIES[cursor.next % QUERIES.length];
      // maxTotalChargeUsd: Apify corta la ejecución si pasara de ese coste (0,5 $ es el mínimo que acepta el actor).
      let run = (await api(http, token, `/acts/${APIFY_ACTOR}/runs?maxTotalChargeUsd=0.5&timeout=300&waitForFinish=60`, { method: "POST", body: JSON.stringify(actorInput(query)) })).data;
      const deadline = Date.now() + 6 * 60_000;
      while (["READY", "RUNNING"].includes(run.status) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 10_000));
        run = (await api(http, token, `/actor-runs/${run.id}`)).data;
      }
      const cost = Number(run.usageTotalUsd) || 0;
      const next: TikTokCursor = { ...cursor, spentUsd: cursor.spentUsd + Math.max(cost, run.status === "SUCCEEDED" ? 0 : RUN_ESTIMATE_USD), next: cursor.next + 1 };
      await deps.store.set(JSON.stringify(next));
      if (run.status !== "SUCCEEDED") throw new SourceError(`apify_${String(run.status).toLowerCase()}`, `La búsqueda de TikTok terminó en ${run.status}`);

      const videos: any[] = await api(http, token, `/datasets/${run.defaultDatasetId}/items?clean=true`);
      const comments: TikTokComment[] = [];
      for (const v of videos) {
        const m = typeof v.commentsDatasetUrl === "string" ? v.commentsDatasetUrl.match(/\/datasets\/([^/]+)\/items/) : null;
        if (!m) continue;
        comments.push(...(await api(http, token, `/datasets/${m[1]}/items?clean=true`)));
      }
      deps.log?.(`comunidades: tiktok «${query}»: ${videos.length} vídeos, ${comments.length} comentarios, ${cost.toFixed(3)} $ (mes: ${next.spentUsd.toFixed(2)} $)`);
      return postsFromComments(comments, videos);
    },
  };
}
