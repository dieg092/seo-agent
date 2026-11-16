// src/bridge/scopeCheck.ts
// Control de alcance de un PR del agente (anexo C §4, job seo-pr): los ficheros
// y las líneas del diff tienen que caber en el alcance de su operación del
// catálogo (OPERATION_SCOPES). La CI lo ejecuta con el código de seo-agent de
// main, nunca con el del PR. Lógica pura.
import { OPERATION_SCOPES } from "./contract";

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
}

/** `git diff --numstat` a lista de ficheros. Los binarios («-») cuentan como 1 línea. */
export function parseNumstat(text: string): DiffFile[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, d, ...rest] = l.split("\t");
      const path = rest.join("\t");
      const n = (x: string) => (x === "-" ? 1 : Number(x) || 0);
      return { path, added: n(a), deleted: n(d) };
    });
}

/** Glob con * (dentro de un segmento) y ** (cualquier número de segmentos). */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface ScopeResult {
  ok: boolean;
  errors: string[];
}

export function checkScope(operation: string, files: DiffFile[]): ScopeResult {
  const scope = OPERATION_SCOPES[operation];
  if (!scope) return { ok: false, errors: [`la operación «${operation}» no está en el catálogo A1`] };
  const errors: string[] = [];
  const allowed = scope.allowedPaths.map(globToRegExp);
  for (const f of files) {
    if (f.path.includes("=>")) errors.push(`renombrado no permitido: ${f.path}`);
    else if (!allowed.some((r) => r.test(f.path))) errors.push(`fuera del alcance de ${operation}: ${f.path}`);
  }
  if (files.length > scope.maxFilesChanged) errors.push(`${files.length} ficheros (máximo ${scope.maxFilesChanged})`);
  const lines = files.reduce((s, f) => s + f.added + f.deleted, 0);
  if (lines > scope.maxLinesChanged) errors.push(`${lines} líneas cambiadas (máximo ${scope.maxLinesChanged})`);
  if (files.length === 0) errors.push("el PR no cambia nada");
  return { ok: errors.length === 0, errors };
}
