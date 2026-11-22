// src/communities/telegramBot.ts
// Grupo propio de novias en Telegram con el bot que ya existe (@miwebdeboda_alerts_bot):
//  - lo acepta solo si lo añade como administrador el fundador (TELEGRAM_CHAT_ID = su usuario);
//  - lee las preguntas del grupo (getUpdates) y las convierte en candidatas;
//  - publica un consejo del blog los martes, jueves y sábados desde las 10:00 de Madrid (sin modelo).
// El cursor (offset de getUpdates, grupo y artículos ya publicados) vive en CommunitySource.cursor.
import type { RawPost } from "./core";
import { madrid } from "./core";
import { SourceError, type Source } from "./sources";

export interface BotCursor { offset: number; chatId?: number; username?: string | null; title?: string; posted: string[]; lastTipDay?: string }

export const emptyCursor = (): BotCursor => ({ offset: 0, posted: [] });

export function parseCursor(raw: string | null | undefined): BotCursor {
  try {
    return raw ? { ...emptyCursor(), ...JSON.parse(raw) } : emptyCursor();
  } catch {
    return emptyCursor();
  }
}

/** Enlace a un mensaje: público con @usuario; si no, el de supergrupo (solo lo abren los miembros). */
export function messageUrl(chatId: number, username: string | null | undefined, messageId: number): string | null {
  if (username) return `https://t.me/${username}/${messageId}`;
  const s = String(chatId);
  return s.startsWith("-100") ? `https://t.me/c/${s.slice(4)}/${messageId}` : null;
}

/** Procesa un lote de getUpdates: alta del grupo y mensajes con texto del grupo aceptado. */
export function processUpdates(updates: any[], cursor: BotCursor, founderId: number): { cursor: BotCursor; posts: RawPost[] } {
  const c: BotCursor = { ...cursor, posted: [...cursor.posted] };
  const posts: RawPost[] = [];
  for (const u of updates) {
    c.offset = Math.max(c.offset, (u.update_id ?? 0) + 1);
    const mcm = u.my_chat_member;
    if (mcm && ["group", "supergroup"].includes(mcm.chat?.type)) {
      const admin = ["administrator", "creator"].includes(mcm.new_chat_member?.status);
      if (admin && mcm.from?.id === founderId) Object.assign(c, { chatId: mcm.chat.id, username: mcm.chat.username ?? null, title: mcm.chat.title });
      else if (mcm.chat.id === c.chatId && !admin) Object.assign(c, { chatId: undefined, username: undefined, title: undefined });
      continue;
    }
    const m = u.message;
    if (!m || m.chat?.id !== c.chatId || !m.text || m.from?.is_bot || m.from?.id === founderId) continue;
    if (m.chat.username !== undefined) c.username = m.chat.username ?? null;
    const url = messageUrl(m.chat.id, c.username, m.message_id);
    if (!url) continue;
    posts.push({ canonicalId: `${m.chat.id}:${m.message_id}`, url, text: m.text, publishedAt: new Date(m.date * 1000), spain: true });
  }
  return { cursor: c, posts };
}

export interface FeedItem { title: string; url: string; summary: string }

export function parseFeed(xml: string): FeedItem[] {
  const dec = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, b]) => ({
    title: dec(b.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""),
    url: dec(b.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ""),
    summary: dec(b.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? ""),
  })).filter((i) => i.title && i.url.startsWith("https://miwebdeboda.com/"));
}

/** ¿Toca consejo hoy? Martes, jueves y sábado desde las 10:00 de Madrid, uno al día. */
export function tipDue(now: Date, cursor: BotCursor): boolean {
  const { day, hour } = madrid(now);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 domingo
  return Boolean(cursor.chatId) && [2, 4, 6].includes(weekday) && hour >= 10 && cursor.lastTipDay !== day;
}

export function tipMessage(item: FeedItem): string {
  const u = new URL(item.url);
  u.searchParams.set("utm_source", "telegram");
  u.searchParams.set("utm_medium", "community");
  u.searchParams.set("utm_campaign", "grupo_novias");
  return `📌 ${item.title}\n\n${item.summary}\n\n${u.toString()}`;
}

type Http = typeof fetch;

async function bot(http: Http, token: string, method: string, body: object): Promise<any> {
  const r = await http(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  if (r.status === 429) throw new SourceError("flood_wait", "Telegram pide esperar");
  if (!j.ok) throw new SourceError(`telegram_${r.status}`, String(j.description ?? r.status).slice(0, 120));
  return j.result;
}

/**
 * Fuente «telegram». Necesita guardar el cursor entre ejecuciones, así que recibe un almacén
 * (en producción, la columna CommunitySource.cursor).
 */
export function telegramBotSource(store: { get: () => Promise<string | null>; set: (v: string) => Promise<void> }): Source {
  return {
    kind: "telegram",
    everyMs: 30 * 60_000,
    configured: (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    async fetch(now, env, http = fetch) {
      const token = env.TELEGRAM_BOT_TOKEN!;
      const founderId = Number(env.TELEGRAM_CHAT_ID);
      let cursor = parseCursor(await store.get());
      const updates = await bot(http, token, "getUpdates", { offset: cursor.offset, timeout: 0, allowed_updates: ["message", "my_chat_member"] });
      const r = processUpdates(updates, cursor, founderId);
      cursor = r.cursor;
      if (tipDue(now, cursor)) {
        const items = parseFeed(await (await http("https://miwebdeboda.com/feed.xml")).text());
        const next = items.find((i) => !cursor.posted.includes(i.url));
        if (next) {
          await bot(http, token, "sendMessage", { chat_id: cursor.chatId, text: tipMessage(next), disable_web_page_preview: false });
          cursor.posted = [...cursor.posted, next.url].slice(-200);
        }
        cursor.lastTipDay = madrid(now).day;
      }
      await store.set(JSON.stringify(cursor));
      return r.posts;
    },
  };
}
