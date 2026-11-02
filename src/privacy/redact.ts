import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { SITE_ORIGIN, isPrivateUrl, normalizeUrl } from "./sitePrivacy";

/**
 * Redacción y cifrado de URLs privadas (§13.1 de la spec).
 * - Toda URL privada se guarda como `https://miwebdeboda.com/<privada:{hmac12}>`.
 * - La URL real solo se guarda cifrada (AES-256-GCM) en PrivateIncident.urlEncrypted.
 * Sin `SEO_PRIVATE_URL_KEY` todo falla: nunca se guarda una URL en claro.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Devuelve la clave o lanza un error claro. Los colectores la piden antes de escribir nada. */
export function requirePrivateUrlKey(key?: string): string {
  const value = key ?? process.env.SEO_PRIVATE_URL_KEY;
  if (!value) {
    throw new Error(
      "Falta SEO_PRIVATE_URL_KEY: sin ella no se pueden redactar las URLs privadas y no se guarda nada."
    );
  }
  return value;
}

/** Los 12 primeros caracteres hex de HMAC-SHA256(clave, normalizeUrl(url)). */
export function hmac12(url: string, key?: string): string {
  const secret = requirePrivateUrlKey(key);
  return createHmac("sha256", secret).update(normalizeUrl(url)).digest("hex").slice(0, 12);
}

/** Las URLs públicas se devuelven normalizadas; las privadas, redactadas. */
export function redactUrl(url: string, key?: string): string {
  // La clave se exige siempre, también con URLs públicas, para fallar pronto.
  const secret = requirePrivateUrlKey(key);
  if (!isPrivateUrl(url)) return normalizeUrl(url);
  return `${SITE_ORIGIN}/<privada:${hmac12(url, secret)}>`;
}

function encryptionKey(key?: string): Buffer {
  return createHash("sha256").update(`${requirePrivateUrlKey(key)}:enc`).digest();
}

/** Cifra la URL real con AES-256-GCM. Devuelve base64(iv|tag|ct). */
export function encryptUrl(url: string, key?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  const ct = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptUrl(blob: string, key?: string): string {
  const encKey = encryptionKey(key);
  const data = Buffer.from(blob, "base64");
  if (data.length < IV_BYTES + TAG_BYTES) throw new Error("URL cifrada no válida");
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = data.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
