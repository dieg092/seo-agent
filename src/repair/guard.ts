// src/repair/guard.ts
// Guarda independiente del diff del agente reparador (plan de Codex, punto 2): el JSON del
// agente es una propuesta; lo que manda es el diff real. Determinista y sin modelo.

export interface DiffFile {
  path: string;
  /** A (añadido), M (modificado), D (borrado), R (renombrado), T (cambio de tipo)… */
  status: string;
  added: number;
  deleted: number;
  /** Modo git del fichero resultante (120000 = enlace simbólico). */
  mode?: string;
  /** Líneas añadidas (sin el «+»). */
  addedLines: string[];
}

/** Rutas donde el reparador puede escribir. */
const ALLOWED = [/^src\/.+\.ts$/, /^scripts\/[^/]+\.ts$/];

/** Rutas que el reparador nunca toca, aunque estén dentro de las permitidas. */
const FORBIDDEN = [
  /^src\/repair\//, // el supervisor no se repara a sí mismo
  /^scripts\/seo-repair\.ts$/,
  /^scripts\/seo-export/, // nunca seo-export
  /^src\/editorial\/rubric\.ts$/, // rúbrica
  /^src\/editorial\/budget\.ts$/, // presupuesto del modelo
  /^src\/editorial\/fixtures\//, // casos de la batería
  /^src\/privacy\//, // política de privacidad de salida
  /^src\/env\.ts$/,
  /^src\/dbGuard\.ts$/,
  /^src\/db\.ts$/,
];

/** Constantes de umbral que no se cambian para «hacer que pase». */
const THRESHOLD_RE =
  /\b(CRITERION_FLOOR|BATTERY_MIN_RATE|MAX_QUALITY_ATTEMPTS|QUALITY_BACKOFF_HOURS|EDITORIAL_DAILY_[A-Z_]+|[A-Z_]*THRESHOLD[A-Z_]*|[A-Z_]*_MIN_[A-Z_]*|[A-Z_]*_MAX_[A-Z_]*)\s*=/;

const SECRETISH_RE = /(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']|-----BEGIN [A-Z ]*PRIVATE KEY/i;

export const MAX_FILES = 8;
export const MAX_LINES = 300;

export function guardDiff(files: DiffFile[]): { ok: true } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  if (files.length === 0) reasons.push("sin cambios");
  if (files.length > MAX_FILES) reasons.push(`demasiados ficheros (${files.length} > ${MAX_FILES})`);
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  if (lines > MAX_LINES) reasons.push(`demasiadas líneas (${lines} > ${MAX_LINES})`);

  for (const f of files) {
    if (!ALLOWED.some((r) => r.test(f.path))) reasons.push(`ruta no permitida: ${f.path}`);
    if (FORBIDDEN.some((r) => r.test(f.path))) reasons.push(`ruta protegida: ${f.path}`);
    if (f.status !== "M" && f.status !== "A") reasons.push(`operación no permitida (${f.status}): ${f.path}`);
    if (f.mode === "120000") reasons.push(`enlace simbólico: ${f.path}`);
    const isTest = f.path.endsWith(".test.ts");
    // En los tests solo se añade: borrar o cambiar una aserción es debilitarla.
    if (isTest && f.deleted > 0) reasons.push(`borra líneas de un test: ${f.path}`);
    for (const l of f.addedLines) {
      if (isTest && /\b(test|it|describe)\.(skip|only|todo)\b|\{\s*skip\s*:/.test(l)) reasons.push(`test saltado o aislado: ${f.path}`);
      if (!isTest && THRESHOLD_RE.test(l)) reasons.push(`cambia un umbral: ${f.path}`);
      if (SECRETISH_RE.test(l)) reasons.push(`parece un secreto: ${f.path}`);
      if (/seo-export/.test(l)) reasons.push(`menciona seo-export: ${f.path}`);
    }
  }
  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true };
}

/** Parsea `git diff --numstat` + `git diff --name-status` + `git diff -U0` de la copia. */
export function parseDiff(numstat: string, nameStatus: string, patch: string): DiffFile[] {
  const status = new Map<string, string>();
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const [st, ...paths] = line.split("\t");
    status.set(paths[paths.length - 1], st[0]);
  }
  const addedBy = new Map<string, string[]>();
  const modeBy = new Map<string, string>();
  let current = "";
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (m) {
      current = m[1];
      addedBy.set(current, []);
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    const mode = /^new (?:file )?mode (\d+)$/.exec(line);
    if (mode && current) modeBy.set(current, mode[1]);
    if (line.startsWith("+") && current) addedBy.get(current)!.push(line.slice(1));
  }
  return numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, path] = line.split("\t");
      return {
        path,
        status: status.get(path) ?? "M",
        added: a === "-" ? MAX_LINES + 1 : Number(a),
        deleted: d === "-" ? MAX_LINES + 1 : Number(d),
        mode: modeBy.get(path),
        addedLines: addedBy.get(path) ?? [],
      };
    });
}
