// src/privacy/outboundPolicy.ts
// Política de salida: todo lo que sale de seo-agent hacia Órbita, un modelo, un PR o
// una alerta pasa por aquí. Recorre objetos anidados y texto libre y sustituye cada
// URL o ruta privada de la web (bodas, invitaciones, sesión, dominios propios) por
// «[privada]»; quita las claves con datos personales. Ante la duda, privada.
import { isPrivateUrl, SITE_HOST } from "./sitePrivacy";

export const REDACTED = "[privada]";

/** Claves que nunca salen, a cualquier profundidad (datos de personas o secretos). */
const PERSONAL_KEY =
  /^(e-?mail|correo|phone|telefono|tel[eé]fono|name|nombre|first_?name|last_?name|bride|groom|novi[oa]s?|pareja|couple|guest|invitad[oa]s?|address|direcci[oó]n|token|password|secret|ip|user_?id|session)$/i;

// URLs absolutas (cualquier host) y rutas sueltas que empiezan por «/».
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s"'<>()\]]+/gi;
const BARE_PATH = /(^|[\s("'«`])(\/[a-z0-9][a-z0-9\-_.~%/]*(?:\?[^\s"'<>»)]*)?)/gi;
// Dominio de la web sin esquema (miwebdeboda.com/algo).
const SITE_NO_SCHEME = new RegExp(`(?<![/\\w.-])(?:www\\.)?${SITE_HOST.replace(".", "\\.")}(/[^\\s"'<>()\\]]*)?`, "gi");

function privateOrUnreadable(url: string): boolean {
  try {
    return isPrivateUrl(url);
  } catch {
    return true;
  }
}

/** Sustituye las URLs y rutas privadas de un texto libre. */
export function redactText(text: string): string {
  let out = text.replace(ABSOLUTE_URL, (u) => {
    const clean = u.replace(/[.,;:!?»]+$/, "");
    const tail = u.slice(clean.length);
    let host = "";
    try {
      host = new URL(clean).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return REDACTED + tail;
    }
    // Hosts ajenos (BOE, Google…) son públicos; los de la web o dominios propios se clasifican.
    if (host !== SITE_HOST && !host.endsWith(`.${SITE_HOST}`)) return u;
    return (privateOrUnreadable(clean) ? REDACTED : clean) + tail;
  });
  out = out.replace(SITE_NO_SCHEME, (m, path: string | undefined) => {
    const raw = path ?? "";
    const clean = raw.replace(/[.,;:!?»]+$/, "");
    return privateOrUnreadable(`https://${SITE_HOST}${clean || "/"}`) ? REDACTED + raw.slice(clean.length) : m;
  });
  out = out.replace(BARE_PATH, (m, pre: string, path: string) => {
    const clean = path.replace(/[.,;:!?]+$/, "");
    const tail = path.slice(clean.length);
    return pre + (privateOrUnreadable(clean) ? REDACTED : clean) + tail;
  });
  return out;
}

/** Copia redactada de cualquier valor JSON: texto, listas y objetos anidados. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PERSONAL_KEY.test(k)) continue;
      out[redactText(k)] = redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** ¿Queda algo privado? Comprobación final antes de enviar. */
export function containsPrivate(value: unknown): boolean {
  return JSON.stringify(redactValue(value)) !== JSON.stringify(value);
}
