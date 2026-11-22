// src/communities/accounts.ts
// Facebook leído desde los correos de notificación de grupos en el Gmail del fundador
// (IMAP con contraseña de aplicación, solo lectura). Telegram va en telegramBot.ts.
// Las credenciales viven en ~/.comunidades/*.json con permisos 600; nunca en la BD ni en logs.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RawPost } from "./core";
import { SourceError, type Source } from "./sources";

export const ACCOUNTS_DIR = join(homedir(), ".comunidades");
export const GMAIL_FILE = join(ACCOUNTS_DIR, "gmail.json");

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

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
    // Solo llegan notificaciones de los grupos a los que se ha unido el fundador: bodas en España.
    out.push({ canonicalId: p.canonicalId, url: p.url, text, publishedAt: mail.date, spain: true });
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
        let mails = 0;
        for (const uid of uids.slice(-100)) {
          mails++;
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          posts.push(...facebookPostsFromMail({ text: parsed.text ?? "", html: typeof parsed.html === "string" ? parsed.html : "", date: parsed.date ?? null }));
        }
        console.log(`comunidades: facebook_email ${mails} correos de Facebook, ${posts.length} publicaciones de grupo reconocidas`);
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

import type { PrismaClient } from "@prisma/client";
import { youtube } from "./sources";
import { telegramBotSource } from "./telegramBot";

/** Todas las fuentes; el cursor del bot de Telegram se guarda en CommunitySource.cursor. */
export function allSources(db: PrismaClient): Source[] {
  const telegram = telegramBotSource({
    get: async () => (await db.communitySource.findUnique({ where: { kind: "telegram" } }))?.cursor ?? null,
    set: async (v) => void (await db.communitySource.update({ where: { kind: "telegram" }, data: { cursor: v } })),
  });
  return [youtube, telegram, facebookMail];
}
