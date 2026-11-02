/**
 * Clasificación de privacidad de las rutas de miwebdeboda.com (§13.1 de la spec).
 *
 * En wedding-invite-2, `[weddingPageSlug]` captura cualquier ruta de primer
 * nivel, así que la clasificación es **privada por defecto**: una ruta solo es
 * `public` si su primer segmento está en el manifiesto de rutas públicas.
 */

export const SITE_HOST = "miwebdeboda.com";
export const SITE_ORIGIN = `https://${SITE_HOST}`;

/**
 * Manifiesto de rutas públicas: directorios y ficheros de primer nivel de
 * wedding-invite-2/src/app a 2026-11-02, sin segmentos dinámicos ni las rutas
 * privadas (sesión, tokens y dominio propio). Si se añade una página pública
 * nueva en la web hay que añadirla aquí; mientras no esté, se trata como privada
 * (falla del lado seguro).
 */
export const PUBLIC_FIRST_SEGMENTS: readonly string[] = [
  "aviso-legal",
  "blog",
  "calculadora-presupuesto-boda",
  "colaboraciones",
  "confianza",
  "contacto",
  "cookies",
  "estadisticas-bodas",
  "feed.xml",
  "funcionalidades",
  "glosario-bodas",
  "herramientas",
  "invitacion-digital-boda",
  "llms-full.txt",
  "organizar-boda-guia",
  "plantillas",
  "precios",
  "privacidad",
  "profesionales",
  "robots.txt",
  "sitemap.xml",
  "sitemap-images.xml",
  "terminos",
];

/**
 * Primeros segmentos que requieren sesión o son herramientas internas.
 * Excepción: `/tool` a secas es pública (ver classifyPath); solo sus subrutas son privadas.
 */
export const PRIVATE_SESSION_FIRST_SEGMENTS: readonly string[] = [
  "admin",
  "api",
  "login",
  "crear-cuenta",
  "forgot-password",
  "reset-password",
  "verify-email",
  "email-preview",
  "impersonation",
  "logout",
  "register-user",
  "wedding-form",
  "bienvenida",
  "feedback",
  "tool",
  "reel-render",
];

export type PrivacyClass = "public" | "private-session" | "private-unlisted" | "private-token";

const PUBLIC_SET = new Set(PUBLIC_FIRST_SEGMENTS);
const SESSION_SET = new Set(PRIVATE_SESSION_FIRST_SEGMENTS);

/** Clasifica una ruta (`/blog/x`, admite query y barra final). Por defecto, privada. */
export function classifyPath(pathname: string): PrivacyClass {
  const path = pathname.split(/[?#]/)[0];
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return "public";

  const [first, second, third] = segments;
  // /tool es una página pública (sitemap, 200, index); sus subrutas (/tool/experiment…) no.
  if (first === "tool" && segments.length === 1) return "public";
  if (SESSION_SET.has(first)) return "private-session";
  if (first === "colaboraciones" && third === "participar") return "private-session";
  if (first === "dominio-propio") return "private-unlisted";
  if (PUBLIC_SET.has(first)) return "public";
  // /<slug>/i/<token>: invitación personal de un invitado.
  if (second === "i" && segments.length >= 3) return "private-token";
  // Cualquier otro primer segmento lo captura [weddingPageSlug]: web de una pareja.
  return "private-unlisted";
}

/** Host en minúsculas y sin `www.`. */
function canonicalHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function parseUrl(url: string): URL {
  const trimmed = url.trim();
  // Las rutas sueltas (`/blog/x`) se entienden relativas a la web.
  return trimmed.startsWith("/") ? new URL(trimmed, SITE_ORIGIN) : new URL(trimmed);
}

/** Parámetros de seguimiento que no cambian la página: se quitan al normalizar. */
export const TRACKING_PARAMS: readonly string[] = ["fbclid", "gclid", "msclkid", "mc_eid", "_ga", "igshid"];
const TRACKING_SET = new Set(TRACKING_PARAMS);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_SET.has(lower);
}

function decodeParamName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** Quita los parámetros de seguimiento y deja el resto tal cual. Sin nada, cadena vacía. */
function stripTrackingParams(search: string): string {
  if (search.length <= 1) return "";
  const kept = search
    .slice(1)
    .split("&")
    .filter((part) => part.length > 0 && !isTrackingParam(decodeParamName(part.split("=")[0])));
  return kept.length > 0 ? `?${kept.join("&")}` : "";
}

/**
 * Normaliza una URL para compararla y para calcular su HMAC:
 * https, host en minúsculas y sin `www.`, sin fragmento ni barra final
 * (la raíz conserva la `/`) y sin parámetros de seguimiento (utm_*, fbclid…).
 * La ruta y el resto de la query se mantienen tal cual.
 */
export function normalizeUrl(url: string): string {
  const parsed = parseUrl(url);
  const host = canonicalHost(parsed.host);
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  return `https://${host}${path}${stripTrackingParams(parsed.search)}`;
}

/** Clasifica una URL completa: cualquier host distinto de miwebdeboda.com es un dominio propio. */
export function classifyUrl(url: string): PrivacyClass {
  const parsed = parseUrl(url);
  if (canonicalHost(parsed.host) !== SITE_HOST) return "private-unlisted";
  return classifyPath(parsed.pathname);
}

export function isPrivateUrl(url: string): boolean {
  return classifyUrl(url) !== "public";
}
