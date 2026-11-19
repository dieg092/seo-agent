// src/bridge/semanticScope.ts
// Alcance por significado (riesgo 1 de la revisión): además de rutas y número de líneas,
// cada operación A1 solo puede cambiar lo que su contrato dice, comprobado sobre el diff
// real línea a línea. Sin poder leer un fichero, se retiene; si el cambio se sale, se bloquea.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyPath } from "../privacy/sitePrivacy";

export interface FileVersions {
  path: string;
  base: string | null; // null: fichero nuevo
  head: string | null; // null: fichero borrado
}

export interface Hunk {
  removed: string[];
  added: string[];
  /** primera línea del trozo en la versión nueva (1-based) */
  headStart: number;
}

export type SemanticResult = { ok: true } | { ok: false; reason: string };

/** Trozos cambiados entre dos textos (git diff --no-index -U0, sin depender de librerías). */
export function diffHunks(base: string, head: string): Hunk[] {
  const dir = mkdtempSync(join(tmpdir(), "seo-scope-"));
  try {
    writeFileSync(join(dir, "a"), base);
    writeFileSync(join(dir, "b"), head);
    let out = "";
    try {
      out = execFileSync("git", ["diff", "--no-index", "--no-color", "-U0", "a", "b"], { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      // git diff --no-index sale con 1 cuando hay diferencias
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    const hunks: Hunk[] = [];
    let cur: Hunk | null = null;
    for (const line of out.split("\n")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        cur = { removed: [], added: [], headStart: Number(m[1]) };
        hunks.push(cur);
      } else if (cur && line.startsWith("-") && !line.startsWith("---")) cur.removed.push(line.slice(1));
      else if (cur && line.startsWith("+") && !line.startsWith("+++")) cur.added.push(line.slice(1));
    }
    return hunks;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const META_KEY = /^\s*(title|description|seoTitle|metaTitle|seoDescription|metaDescription|ogTitle|ogDescription)\s*:/;
const STRING_ONLY = /^\s*(["'`]).*\1\s*,?\s*$/;
const COMMENT = /^\s*(\/\/|\/\*|\*)/;
const BLANK = /^\s*$/;
const DATE_KEY = /^\s*(updatedAt|dateModified)\s*:\s*["'`][0-9T:.\-Z+]+["'`]\s*,?\s*$/;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return url;
  }
}

/** Ruta de la web que sirve un page.tsx del App Router (sin grupos ni segmentos privados). */
export function routeOfPage(file: string): string | null {
  const m = /^src\/app\/(.*)page\.tsx$/.exec(file);
  if (!m) return null;
  const segs = m[1].split("/").filter((s) => s && !/^\(.*\)$/.test(s));
  if (segs.some((s) => s.startsWith("[") || s.startsWith("_") || s.startsWith("@"))) return null;
  return "/" + segs.join("/");
}

/** Slug del post de posts.ts al que pertenece una línea (el `slug:` más cercano por encima). */
function slugAbove(lines: string[], lineIdx: number): string | null {
  for (let i = Math.min(lineIdx, lines.length - 1); i >= 0 && i > lineIdx - 80; i--) {
    const m = /^\s*slug:\s*["']([^"']+)["']/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function checkMeta(files: FileVersions[], contractUrls: string[]): SemanticResult {
  const paths = new Set(contractUrls.map(pathOf));
  const slugs = new Set([...paths].map((p) => p.split("/").filter(Boolean).pop() ?? ""));
  for (const f of files) {
    if (f.base === null || f.head === null) return { ok: false, reason: `${f.path}: meta-title-description no crea ni borra ficheros` };
    const headLines = f.head.split("\n");
    for (const h of diffHunks(f.base, f.head)) {
      for (const l of [...h.removed, ...h.added]) {
        if (!(META_KEY.test(l) || STRING_ONLY.test(l) || COMMENT.test(l) || BLANK.test(l) || DATE_KEY.test(l))) {
          return { ok: false, reason: `${f.path}: cambia algo que no es title ni description («${l.trim().slice(0, 60)}»)` };
        }
      }
      if (f.path === "src/lib/blog/posts.ts") {
        const slug = slugAbove(headLines, h.headStart - 1);
        if (!slug || !slugs.has(slug)) return { ok: false, reason: `posts.ts: cambia el post «${slug ?? "?"}», que no es el del contrato` };
      }
    }
    if (f.path.endsWith("page.tsx")) {
      const route = routeOfPage(f.path);
      if (!route || !paths.has(route)) return { ok: false, reason: `${f.path}: no es la página de ninguna URL del contrato` };
    }
    if (f.path === "src/lib/seo/home-metadata.ts" && !paths.has("/")) return { ok: false, reason: "home-metadata.ts sin la portada en el contrato" };
  }
  return { ok: true };
}

// Enlaces internos dentro de una línea: href="/x", ](/x), "/x".
const INTERNAL_LINK = /(?<=["'(`\s=])\/(?!\/)[a-z0-9][a-z0-9\-_/.]*(?:#[a-z0-9\-_]+)?/gi;

function checkBrokenLinks(files: FileVersions[]): SemanticResult {
  for (const f of files) {
    if (f.base === null || f.head === null) return { ok: false, reason: `${f.path}: arreglar un enlace no crea ni borra ficheros` };
    for (const h of diffHunks(f.base, f.head)) {
      if (h.removed.length !== h.added.length) return { ok: false, reason: `${f.path}: un arreglo de enlace cambia líneas, no solo destinos` };
      for (let i = 0; i < h.added.length; i++) {
        const a = h.removed[i].replace(INTERNAL_LINK, "<L>");
        const b = h.added[i].replace(INTERNAL_LINK, "<L>");
        if (a !== b) return { ok: false, reason: `${f.path}: cambia texto además del destino del enlace` };
        for (const target of h.added[i].match(INTERNAL_LINK) ?? []) {
          if (classifyPath(target) !== "public") return { ok: false, reason: `${f.path}: el nuevo destino no es una página pública` };
        }
      }
    }
  }
  return { ok: true };
}

const CONTENT_OPEN = /const content = `/;

/** Lo que queda fuera de la plantilla `const content = \`…\``. */
function outsideContent(src: string): string | null {
  const open = CONTENT_OPEN.exec(src);
  if (!open) return null;
  const start = open.index + open[0].length;
  // cierre: la primera comilla invertida no escapada
  for (let i = start; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "`") return src.slice(0, start) + "<CONTENIDO>" + src.slice(i);
  }
  return null;
}

function checkContent(files: FileVersions[]): SemanticResult {
  for (const f of files) {
    if (f.base === null || f.head === null) return { ok: false, reason: `${f.path}: mejorar un artículo no crea ni borra ficheros` };
    if (f.path === "src/lib/blog/posts.ts") {
      for (const h of diffHunks(f.base, f.head)) {
        for (const l of [...h.removed, ...h.added]) if (!DATE_KEY.test(l)) return { ok: false, reason: "posts.ts: solo puede cambiar la fecha de actualización" };
      }
      continue;
    }
    const a = outsideContent(f.base);
    const b = outsideContent(f.head);
    if (a === null || b === null) return { ok: false, reason: `${f.path}: no tiene la forma const content = \`…\`` };
    if (a !== b) return { ok: false, reason: `${f.path}: cambia algo fuera del texto del artículo` };
  }
  return { ok: true };
}

const ALT_ATTR = /\balt=(["'])(.*?)\1/g;
const MD_IMAGE_ALT = /!\[([^\]]*)\]\(/g;

function alts(line: string): string[] {
  return [...line.matchAll(ALT_ATTR)].map((m) => m[2]).concat([...line.matchAll(MD_IMAGE_ALT)].map((m) => m[1]));
}

/** Un alt útil: con palabras, no el nombre del archivo. */
export function goodAlt(alt: string): boolean {
  const t = alt.trim();
  return t.length >= 5 && /\s/.test(t) && !/\.(webp|jpe?g|png|gif|avif|svg)$/i.test(t);
}

function checkImageAlt(files: FileVersions[]): SemanticResult {
  for (const f of files) {
    if (f.base === null || f.head === null) return { ok: false, reason: `${f.path}: cambiar un alt no crea ni borra ficheros` };
    for (const h of diffHunks(f.base, f.head)) {
      if (h.removed.length !== h.added.length) return { ok: false, reason: `${f.path}: cambia líneas, no solo textos alternativos` };
      for (let i = 0; i < h.added.length; i++) {
        const strip = (l: string) => l.replace(ALT_ATTR, "alt=<A>").replace(MD_IMAGE_ALT, "![<A>](");
        if (strip(h.removed[i]) !== strip(h.added[i])) return { ok: false, reason: `${f.path}: cambia algo además del texto alternativo` };
        const before = alts(h.removed[i]);
        for (const [j, alt] of alts(h.added[i]).entries()) {
          if (alt !== before[j] && !goodAlt(alt)) return { ok: false, reason: `${f.path}: un alt nuevo está vacío o es el nombre del archivo` };
        }
      }
    }
  }
  return { ok: true };
}

const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
export const MAX_NEW_LINKS = 15;
export const MAX_NEW_LINKS_PER_FILE = 3;

function checkLinksBatch(files: FileVersions[]): SemanticResult {
  let total = 0;
  for (const f of files) {
    if (f.base === null || f.head === null) return { ok: false, reason: `${f.path}: añadir enlaces no crea ni borra ficheros` };
    let inFile = 0;
    for (const h of diffHunks(f.base, f.head)) {
      if (h.removed.length !== h.added.length) return { ok: false, reason: `${f.path}: cambia líneas, no solo añade enlaces` };
      for (let i = 0; i < h.added.length; i++) {
        const plain = (l: string) => l.replace(MD_LINK, "$1");
        if (plain(h.removed[i]) !== plain(h.added[i])) return { ok: false, reason: `${f.path}: cambia el texto además de enlazarlo` };
        const old = new Set([...h.removed[i].matchAll(MD_LINK)].map((m) => m[2]));
        const fresh = [...h.added[i].matchAll(MD_LINK)].map((m) => m[2]).filter((u) => !old.has(u));
        for (const target of fresh) {
          if (!target.startsWith("/") || target.startsWith("//") || classifyPath(target) !== "public") return { ok: false, reason: `${f.path}: un enlace nuevo no apunta a una página pública de la web` };
        }
        inFile += fresh.length;
      }
    }
    if (inFile > MAX_NEW_LINKS_PER_FILE) return { ok: false, reason: `${f.path}: más de ${MAX_NEW_LINKS_PER_FILE} enlaces nuevos en un artículo` };
    total += inFile;
  }
  if (total === 0) return { ok: false, reason: "no añade ningún enlace" };
  if (total > MAX_NEW_LINKS) return { ok: false, reason: `más de ${MAX_NEW_LINKS} enlaces nuevos` };
  return { ok: true };
}

function checkRobotsSitemap(files: FileVersions[]): SemanticResult {
  for (const f of files) {
    if (f.path !== "src/app/robots.ts" || f.base === null || f.head === null) return { ok: false, reason: "solo se puede tocar src/app/robots.ts" };
    for (const h of diffHunks(f.base, f.head)) {
      if (h.removed.length > 0) return { ok: false, reason: "robots.ts: no se puede quitar nada" };
      if (h.added.some((l) => !/sitemap/i.test(l) && !BLANK.test(l))) return { ok: false, reason: "robots.ts: solo se puede añadir la línea del sitemap" };
    }
  }
  return { ok: true };
}

/** Comprobación por operación. Las operaciones sin regla propia no pasan a fusión automática. */
export function semanticScope(operation: string, files: FileVersions[], contractUrls: string[]): SemanticResult {
  if (files.length === 0) return { ok: false, reason: "el PR no cambia ningún fichero" };
  switch (operation) {
    case "meta-title-description":
      return checkMeta(files, contractUrls);
    case "broken-internal-link-fix":
      return checkBrokenLinks(files);
    case "content-improve":
      return checkContent(files);
    case "image-alt":
      return checkImageAlt(files);
    case "internal-links-batch":
      return checkLinksBatch(files);
    case "robots-restore-sitemap-directive":
      return checkRobotsSitemap(files);
    default:
      return { ok: false, reason: `la operación ${operation} no tiene comprobación de alcance por significado` };
  }
}
