// src/communities/accounts.ts
// Telegram (API oficial de cliente, cuenta del fundador, solo lectura) y Facebook leído desde
// los correos de notificación de grupos en su Gmail (IMAP con contraseña de aplicación).
// Las credenciales viven en ~/.comunidades/*.json con permisos 600; nunca en la BD ni en logs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RawPost } from "./core";
import { SourceError, type Source } from "./sources";

export const ACCOUNTS_DIR = join(homedir(), ".comunidades");
export const TELEGRAM_FILE = join(ACCOUNTS_DIR, "telegram.json");
export const GMAIL_FILE = join(ACCOUNTS_DIR, "gmail.json");

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

// ---------- Telegram ----------

export interface TgGroup { id: string; username: string | null; title: string }
export interface TgMessage { id: number; text: string; date: number }

/** Grupos de bodas por el título. Solo públicos (con @usuario): de los privados no se envía texto al modelo. */
export function weddingGroups(groups: TgGroup[]): TgGroup[] {
  return groups.filter((g) => g.username && /(novi[ao]s?|bodas?|casamos|casarnos|2026|2027)/i.test(g.title));
}

export function telegramPosts(group: TgGroup, messages: TgMessage[]): RawPost[] {
  if (!group.username) return [];
  return messages
    .filter((m) => m.text && m.text.length >= 20)
    .map((m) => ({ canonicalId: `${group.id}:${m.id}`, url: `https://t.me/${group.username}/${m.id}`, text: m.text, publishedAt: new Date(m.date * 1000) }));
}

interface TgConfig { apiId: number; apiHash: string; session: string }

export const telegram: Source = {
  kind: "telegram",
  everyMs: 3 * 3_600_000,
  configured: () => readJson<TgConfig>(TELEGRAM_FILE)?.session != null,
  async fetch(now) {
    const cfg = readJson<TgConfig>(TELEGRAM_FILE);
    if (!cfg) throw new SourceError("needs_auth", "sin sesión de Telegram");
    const { TelegramClient } = await import("teleproto");
    const { StringSession } = await import("teleproto/sessions");
    const client = new TelegramClient(new StringSession(cfg.session), cfg.apiId, cfg.apiHash, { connectionRetries: 2 });
    client.setLogLevel?.("none" as never);
    try {
      await client.connect();
      if (!(await client.checkAuthorization())) throw new SourceError("needs_auth", "la sesión de Telegram ha caducado");
      const dialogs = await client.getDialogs({ limit: 200 });
      const groups = weddingGroups(
        dialogs
          .filter((d: any) => d.isGroup || d.isChannel)
          .map((d: any) => ({ id: String(d.id), username: (d.entity as any)?.username ?? null, title: d.title ?? "" })),
      );
      const since = Math.floor(now.getTime() / 1000) - 3 * 86_400;
      const posts: RawPost[] = [];
      for (const g of groups.slice(0, 30)) {
        const msgs = await client.getMessages(g.username!, { limit: 100 });
        posts.push(...telegramPosts(g, msgs.filter((m: any) => m.date >= since && !m.out).map((m: any) => ({ id: m.id, text: m.message ?? "", date: m.date }))));
      }
      return posts;
    } catch (e: any) {
      if (e instanceof SourceError) throw e;
      if (/FLOOD_WAIT/.test(String(e?.message))) throw new SourceError("flood_wait", "Telegram pide esperar");
      throw new SourceError("telegram_error", String(e?.message ?? e).slice(0, 120));
    } finally {
      await client.disconnect().catch(() => {});
    }
  },
};

// ---------- Facebook por Gmail ----------

/** Enlace limpio a una publicación de grupo, también si viene envuelto en /nd/?... (sin seguir redirecciones). */
export function facebookGroupPost(href: string): { canonicalId: string; url: string } | null {
  let s = href.replace(/&amp;/g, "&");
  try {
    const u = new URL(s);
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
    if (u.pathname.startsWith("/nd/")) s = `https://www.facebook.com/${decodeURIComponent(u.search.slice(1).split("&")[0])}`;
  } catch {
    return null;
  }
  const m = s.match(/facebook\.com\/groups\/([\w.-]+)\/(?:posts|permalink)\/(\d+)/);
  return m ? { canonicalId: `${m[1]}/${m[2]}`, url: `https://www.facebook.com/groups/${m[1]}/posts/${m[2]}/` } : null;
}

/** Texto útil de una notificación: sin enlaces, pies ni avisos de baja. */
export function notificationText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/https?:\/\/|facebook|darte de baja|darse de baja|notificaci|configuraci|privacidad|meta platforms|ver publicaci|responder|me gusta|comentar/i.test(l))
    .join(" ")
    .slice(0, 1500);
}

export function facebookPostsFromMail(mail: { text: string; html: string; date: Date | null }): RawPost[] {
  const hrefs = [...(mail.html.match(/href="([^"]+)"/g) ?? []).map((h) => h.slice(6, -1)), ...(mail.text.match(/https?:\/\/\S+/g) ?? [])];
  const seen = new Set<string>();
  const out: RawPost[] = [];
  const text = notificationText(mail.text);
  for (const h of hrefs) {
    const p = facebookGroupPost(h);
    if (!p || seen.has(p.canonicalId)) continue;
    seen.add(p.canonicalId);
    out.push({ canonicalId: p.canonicalId, url: p.url, text, publishedAt: mail.date });
  }
  // Un correo con varias publicaciones no permite saber qué texto es de cuál: se descarta.
  return out.length === 1 ? out : [];
}

interface MailConfig { user: string; appPassword: string }

export const facebookMail: Source = {
  kind: "facebook_email",
  everyMs: 3_600_000,
  configured: () => readJson<MailConfig>(GMAIL_FILE)?.appPassword != null,
  async fetch(now) {
    const cfg = readJson<MailConfig>(GMAIL_FILE);
    if (!cfg) throw new SourceError("needs_auth", "sin acceso a Gmail");
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: cfg.user, pass: cfg.appPassword }, logger: false });
    const posts: RawPost[] = [];
    try {
      await client.connect();
      const boxes = await client.list();
      const all = boxes.find((b: any) => b.specialUse === "\\All")?.path ?? "INBOX";
      const lock = await client.getMailboxLock(all, { readOnly: true });
      try {
        const uids = (await client.search({ from: "facebookmail.com", since: new Date(now.getTime() - 3 * 86_400_000) }, { uid: true })) || [];
        for (const uid of uids.slice(-100)) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          posts.push(...facebookPostsFromMail({ text: parsed.text ?? "", html: typeof parsed.html === "string" ? parsed.html : "", date: parsed.date ?? null }));
        }
      } finally {
        lock.release();
      }
    } catch (e: any) {
      if (/auth|credentials|AUTHENTICATIONFAILED/i.test(String(e?.message))) throw new SourceError("needs_auth", "Gmail rechazó la contraseña de aplicación");
      throw new SourceError("gmail_error", String(e?.message ?? e).slice(0, 120));
    } finally {
      await client.logout().catch(() => {});
    }
    return posts;
  },
};

import { youtube } from "./sources";
export const ALL_SOURCES: Source[] = [youtube, telegram, facebookMail];
