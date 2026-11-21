// src/repair/web/guard.ts
// Guarda del diff del reparador web. Las rutas protegidas salen de protegido.txt de
// miwebdeboda-deploy (la misma lista que usa la puerta de despliegue para pedir huella): una
// reparación que las toque NO se publica, se avisa al fundador.
import type { DiffFile } from "../guard";

export const WEB_MAX_FILES = 8;
export const WEB_MAX_LINES = 300;

/** Dónde puede escribir el reparador web (además, nunca en lo protegido). */
const ALLOWED = [/^src\/.+\.(ts|tsx|css)$/, /^scripts\/[^/]+\.ts$/, /^e2e\/.+\.spec\.ts$/];

/** Nunca, aunque protegido.txt no lo diga. */
const FORBIDDEN = [
  /(^|\/)\.env/,
  /^prisma\//, // esquema y migraciones: cambian la BD de producción
  /^scripts\/export-seo-data\.ts$/, // seo:export
  /^src\/lib\/seo\/seo-guard\.test\.ts$/, // la guarda SEO y la paleta Stitch
  /^src\/lib\/blog\/facts-bank\.md$/,
];

/** Mismo formato que protectedMatcher de miwebdeboda-deploy/scripts/verify-deployable.mjs. */
export function protectedMatcher(text: string): (p: string) => boolean {
  const esc = (x: string) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const toRe = (g: string) =>
    new RegExp(
      "^" +
        g
          .split("**/")
          .map((a) => a.split("**").map((b) => b.split("*").map(esc).join("[^/]*")).join(".*"))
          .join("(?:.*/)?") +
        "$"
    );
  const rules = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("!") ? { neg: true, re: toRe(l.slice(1)) } : { neg: false, re: toRe(l) }));
  return (p) => {
    let hit = false;
    for (const r of rules) if (r.re.test(p)) hit = !r.neg;
    return hit;
  };
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SKIP_RE = /\b(test|it|describe)\.(skip|only|todo|fixme)\b|\{\s*skip\s*:|\btest\.fail\(|\.skip\(/;
const SECRETISH_RE = /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']|-----BEGIN [A-Z ]*PRIVATE KEY/i;
/** Colores sueltos: la paleta Stitch es obligatoria (la comprueba también seo-guard.test.ts). */
const RAW_COLOR_RE = /#[0-9a-fA-F]{6}\b|\brgba?\(\s*\d/;

export type WebGuardResult = { ok: true } | { ok: false; protectedHit: boolean; reasons: string[] };

export function guardWebDiff(files: DiffFile[], isProtected: (p: string) => boolean): WebGuardResult {
  const reasons: string[] = [];
  let protectedHit = false;
  if (files.length === 0) reasons.push("sin cambios");
  if (files.length > WEB_MAX_FILES) reasons.push(`demasiados ficheros (${files.length} > ${WEB_MAX_FILES})`);
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  if (lines > WEB_MAX_LINES) reasons.push(`demasiadas líneas (${lines} > ${WEB_MAX_LINES})`);
  for (const f of files) {
    if (isProtected(f.path)) {
      protectedHit = true;
      reasons.push(`fichero protegido (pide huella): ${f.path}`);
    }
    if (FORBIDDEN.some((r) => r.test(f.path))) reasons.push(`ruta prohibida: ${f.path}`);
    if (!ALLOWED.some((r) => r.test(f.path))) reasons.push(`ruta no permitida: ${f.path}`);
    if (f.status !== "M" && f.status !== "A") reasons.push(`operación no permitida (${f.status}): ${f.path}`);
    if (f.mode === "120000") reasons.push(`enlace simbólico: ${f.path}`);
    const isTest = TEST_FILE_RE.test(f.path);
    if (isTest && f.deleted > 0) reasons.push(`borra o cambia líneas de un test: ${f.path}`);
    for (const l of f.addedLines) {
      if (isTest && SKIP_RE.test(l)) reasons.push(`test saltado o aislado: ${f.path}`);
      if (SECRETISH_RE.test(l)) reasons.push(`parece un secreto: ${f.path}`);
      if (/seo-export|seo:export/.test(l)) reasons.push(`menciona seo-export: ${f.path}`);
      if (/https?:\/\/(?!miwebdeboda\.com\b|www\.miwebdeboda\.com\b|localhost)/.test(l) && !isTest) reasons.push(`añade una URL externa: ${f.path}`);
      if (!isTest && RAW_COLOR_RE.test(l)) reasons.push(`color fuera de la paleta Stitch: ${f.path}`);
    }
  }
  return reasons.length ? { ok: false, protectedHit, reasons: [...new Set(reasons)] } : { ok: true };
}
