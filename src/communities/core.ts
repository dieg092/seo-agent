// src/communities/core.ts
// Agente de comunidades (plan de Codex, 22-nov): filtros deterministas, puntuación,
// minimización de datos y selección de las tarjetas del día. Sin red ni BD.
import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RETENTION_DAYS = 7;
export const DAILY_CARDS = 10;
export const PER_SOURCE = 3;
export const MIN_SCORE = 65;
export const MAX_AGE_DAYS = 7;
export const SITE = "https://miwebdeboda.com";

export interface RawPost {
  /** Identificador estable del hilo en la plataforma (id de comentario, de post…). */
  canonicalId: string;
  url: string;
  text: string;
  publishedAt: Date | null;
}

export const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Quita correos, teléfonos, enlaces y menciones, y recorta a 500 caracteres. */
export function minimize(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[correo]")
    .replace(/https?:\/\/\S+|www\.\S+/g, "[enlace]")
    .replace(/(?:\+?\d[\s.-]?){9,}/g, "[teléfono]")
    .replace(/@[\w.]{2,}/g, "@[usuario]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const TOPIC = /\b(invitacion\w*|invitar|confirmacion\w*|confirmar (la )?asistencia|rsvp|whatsapp|web de (la )?boda|pagina de (la )?boda|lista de invitados|invitados|save the date)\b/;
const WEDDING = /\b(boda|bodas|casamos|casarnos|nos casamos|novia|novio|novios|enlace|ceremonia|banquete)\b/;
const NEED = /\?|\b(como (hago|hacemos|puedo|podemos|se hace)|alguien (sabe|conoce|ha usado|recomienda)|recomenda\w*|ideas? para|que (usasteis|usais|me recomendais)|ayuda|consejo)\b/;
const SPAIN = /\b(espana|madrid|barcelona|valencia|sevilla|zaragoza|malaga|bilbao|galicia|andalucia|cataluna|asturias|murcia|alicante|canarias|baleares|vosotros|vuestr[oa]s?|os (recomiendo|cuento)|euros?|€)\b/;
const PROMO = /\b(sorteo|descuento|codigo promocional|oferta|presupuesto sin compromiso|contactanos|escribenos|dm para|link en bio|enlace en bio|compra ya|reserva tu)\b/;
const SENSITIVE = /\b(menor de edad|tengo 1[0-7] anos|suicid|maltrato|violencia)\b/;

export interface Scored { score: number; eligible: boolean; reason: string }

/** Puntuación 0–100 (necesidad 30, tema 25, España 15, < 48 h 15, contestable 15). Umbral 65. */
export function scorePost(p: RawPost, now: Date): Scored {
  const t = norm(p.text);
  const ageMs = p.publishedAt ? now.getTime() - p.publishedAt.getTime() : Infinity;
  if (ageMs > MAX_AGE_DAYS * 86_400_000) return { score: 0, eligible: false, reason: "antiguo" };
  if (PROMO.test(t)) return { score: 0, eligible: false, reason: "promocional" };
  if (SENSITIVE.test(t)) return { score: 0, eligible: false, reason: "sensible" };
  if (!WEDDING.test(t) && !TOPIC.test(t)) return { score: 0, eligible: false, reason: "sin_tema" };
  if (!SPAIN.test(t)) return { score: 0, eligible: false, reason: "sin_senal_espana" };
  let score = 0;
  if (NEED.test(t)) score += 30;
  if (TOPIC.test(t)) score += 25;
  score += 15; // señal de España (obligatoria)
  if (ageMs <= 48 * 3_600_000) score += 15;
  if (t.length >= 40) score += 15;
  return { score, eligible: score >= MIN_SCORE, reason: score >= MIN_SCORE ? "candidata" : "puntuacion_baja" };
}

export interface Candidate { id: string; sourceKind: string; score: number; detectedAt: Date }

/** Mejores primero (puntuación, fecha, id), como mucho PER_SOURCE por fuente y `slots` en total. */
export function selectCards<T extends Candidate>(cands: T[], slots: number): T[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score || b.detectedAt.getTime() - a.detectedAt.getTime() || a.id.localeCompare(b.id));
  const per = new Map<string, number>();
  const out: T[] = [];
  for (const c of sorted) {
    if (out.length >= slots) break;
    const n = per.get(c.sourceKind) ?? 0;
    if (n >= PER_SOURCE) continue;
    per.set(c.sourceKind, n + 1);
    out.push(c);
  }
  return out;
}

/** Día en Madrid (AAAA-MM-DD) y hora local. */
export function madrid(now: Date): { day: string; hour: number } {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const parts = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

const KEY_DIR = join(homedir(), ".comunidades");
const KEY_FILE = join(KEY_DIR, "hmac.key");

/** Clave HMAC local (se crea una vez en el Mac con permisos 600; nunca va a la BD). */
export function hmacKey(file = KEY_FILE): Buffer {
  if (!existsSync(file)) {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return Buffer.from(readFileSync(file, "utf8").trim(), "hex");
}

export function threadKey(kind: string, canonicalId: string, key: Buffer): string {
  return createHmac("sha256", key).update(`${kind}:${canonicalId}`).digest("hex");
}

/** Enlace con UTM para medir qué tarjetas traen registros y pagos. */
export function campaignUrl(path: string, source: string, code: string): string {
  const u = new URL(path, SITE);
  u.searchParams.set("utm_source", source);
  u.searchParams.set("utm_medium", "community");
  u.searchParams.set("utm_campaign", "primeras_parejas");
  u.searchParams.set("utm_content", code);
  return u.toString();
}
