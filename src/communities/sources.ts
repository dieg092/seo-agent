// src/communities/sources.ts
// Fuentes con API oficial y solo lectura. Cada una devuelve publicaciones crudas; los filtros,
// la minimización y la deduplicación se aplican después en runner.ts.
import { google } from "googleapis";
import type { RawPost } from "./core";

export interface Source {
  kind: string;
  /** Cada cuánto vale la pena volver a leer (ms). */
  everyMs: number;
  /** ¿Están las credenciales en el entorno? (no comprueba permisos) */
  configured: (env: NodeJS.ProcessEnv) => boolean;
  fetch: (now: Date, env: NodeJS.ProcessEnv, http?: typeof fetch) => Promise<RawPost[]>;
}

export class SourceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const YT_QUERIES = ["invitación de boda whatsapp", "confirmar asistencia boda", "organizar boda 2027"];

async function getJson(http: typeof fetch, url: string, token: string): Promise<any> {
  const r = await http(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 403 || r.status === 429) throw new SourceError(`http_${r.status}`, `YouTube respondió ${r.status} (cuota o permisos)`);
  if (!r.ok) throw new SourceError(`http_${r.status}`, `YouTube respondió ${r.status}`);
  return r.json();
}

/** YouTube Data API v3: vídeos recientes en español de España y sus comentarios con preguntas. */
export const youtube: Source = {
  kind: "youtube",
  everyMs: 24 * 3_600_000,
  // Usa la cuenta de servicio de Search Console (scope youtube.readonly): no hace falta clave.
  configured: (env) => Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
  async fetch(now, env, http = fetch) {
    const jwt = new google.auth.JWT(env.GOOGLE_SERVICE_ACCOUNT_EMAIL, undefined, env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY!.replace(/\\n/g, "\n"), ["https://www.googleapis.com/auth/youtube.readonly"]);
    const token = (await jwt.getAccessToken()).token;
    if (!token) throw new SourceError("auth", "sin token de Google");
    const after = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const videos = new Set<string>();
    for (const q of YT_QUERIES) {
      const u = new URL("https://www.googleapis.com/youtube/v3/search");
      Object.entries({ part: "id", type: "video", q, regionCode: "ES", relevanceLanguage: "es", order: "date", publishedAfter: after, maxResults: "7" }).forEach(([k, v]) => u.searchParams.set(k, v));
      const d = await getJson(http, u.toString(), token);
      for (const it of d.items ?? []) if (it.id?.videoId) videos.add(it.id.videoId);
    }
    const posts: RawPost[] = [];
    for (const v of [...videos].slice(0, 20)) {
      const u = new URL("https://www.googleapis.com/youtube/v3/commentThreads");
      Object.entries({ part: "snippet", videoId: v, order: "time", maxResults: "50", textFormat: "plainText" }).forEach(([k, val]) => u.searchParams.set(k, val));
      let d: any;
      try {
        d = await getJson(http, u.toString(), token);
      } catch (e) {
        if (e instanceof SourceError && e.code === "http_403") continue; // comentarios desactivados en ese vídeo
        throw e;
      }
      for (const t of d.items ?? []) {
        const top = t.snippet?.topLevelComment;
        const s = top?.snippet;
        if (!top?.id || !s?.textOriginal) continue;
        posts.push({ canonicalId: top.id, url: `https://www.youtube.com/watch?v=${v}&lc=${top.id}`, text: s.textOriginal, publishedAt: s.publishedAt ? new Date(s.publishedAt) : null });
      }
    }
    return posts;
  },
};

/** Fuentes con adaptador. Telegram y Facebook (Gmail) se añaden cuando el fundador conecte su cuenta. */
export const SOURCES: Source[] = [youtube];
