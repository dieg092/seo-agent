// Lectura mínima de robots.txt (RFC 9309) para el rastreador semanal.
// Se elige el grupo cuyo user-agent coincide con el nuestro y, si no hay, el de `*`.
// Dentro del grupo gana la regla más larga que coincide; a igualdad, Allow.

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  /** true si la ruta (con su query) se puede pedir. */
  isAllowed(pathAndQuery: string): boolean;
  rules: RobotsRule[];
}

interface Group {
  agents: string[];
  rules: RobotsRule[];
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      // Varias líneas User-agent seguidas forman un solo grupo.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // `Disallow:` vacío no prohíbe nada.
      if (value.length === 0) continue;
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  return groups;
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

/** Política para nuestro user-agent. Sin grupo aplicable, todo se permite. */
export function parseRobotsTxt(text: string, userAgent: string): RobotsPolicy {
  const groups = parseGroups(text);
  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const chosen = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const compiled = rules.map((r) => ({ ...r, re: patternToRegExp(r.pattern), length: r.pattern.length }));

  return {
    rules,
    isAllowed(pathAndQuery: string): boolean {
      let best: { allow: boolean; length: number } | null = null;
      for (const r of compiled) {
        if (!r.re.test(pathAndQuery)) continue;
        if (!best || r.length > best.length || (r.length === best.length && r.allow)) {
          best = { allow: r.allow, length: r.length };
        }
      }
      return best ? best.allow : true;
    },
  };
}

/** Política que lo permite todo (robots.txt ausente: 4xx). */
export const ALLOW_ALL: RobotsPolicy = { rules: [], isAllowed: () => true };
