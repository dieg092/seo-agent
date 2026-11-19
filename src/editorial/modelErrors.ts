// src/editorial/modelErrors.ts
// Errores del evaluador clasificados (plan de Codex, paso 3). Un límite de cupo no es un fallo de
// calidad: se espera a la hora de reinicio que da el propio mensaje (Europe/Madrid, + 5 min). Si
// no se entiende, o queda fuera de 5 min a 24 h, se esperan 6 h. El texto del error no se guarda.

export type ModelErrorKind = "quota" | "budget" | "busy" | "transient" | "invalid-output" | "permanent-model-error" | "unknown";

export class EditorialDeferred extends Error {
  constructor(
    readonly kind: "budget" | "busy" | "quota",
    readonly retryAt: Date,
    message: string,
  ) {
    super(message);
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const MADRID = "Europe/Madrid";

/** Diferencia UTC−Madrid (ms) en un instante. */
function madridOffset(at: Date): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: MADRID, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Próxima vez que el reloj de Madrid marca h:m después de `now`. */
export function nextMadridTime(now: Date, hour: number, minute: number): Date {
  const off = madridOffset(now);
  const local = new Date(now.getTime() + off);
  let t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) - off;
  if (t <= now.getTime()) t += 24 * HOUR;
  return new Date(t);
}

/** Medianoche de Madrid siguiente (cuando se renueva el presupuesto diario). */
export const nextMadridMidnight = (now: Date) => nextMadridTime(now, 0, 0);

/** Día de Madrid (YYYY-MM-DD) para el presupuesto. */
export function madridDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MADRID, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Hora de reinicio de «resets 4:10pm (Europe/Madrid)» / «resets at 16:10»; null si no se entiende. */
export function parseReset(message: string, now: Date): Date | null {
  const m = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return nextMadridTime(now, h, min);
}

export function classifyModelError(err: unknown, now: Date): { kind: ModelErrorKind; retryAt: Date | null } {
  if (err instanceof EditorialDeferred) return { kind: err.kind, retryAt: err.retryAt };
  const msg = String((err as Error)?.message ?? err);
  if (/hit your .*limit|usage limit|rate limit|limit reached|too many requests|\b429\b/i.test(msg)) {
    const reset = parseReset(msg, now);
    const wait = reset ? reset.getTime() + 5 * MIN - now.getTime() : 0;
    const retryAt = reset && wait >= 5 * MIN && wait <= 24 * HOUR ? new Date(reset.getTime() + 5 * MIN) : new Date(now.getTime() + 6 * HOUR);
    return { kind: "quota", retryAt };
  }
  if (/model.*(not found|not available|invalid|unsupported)|unknown model|authentication|not logged in|invalid api key|\b401\b|\b403\b/i.test(msg)) return { kind: "permanent-model-error", retryAt: null };
  if (/json|schema|parse|unexpected token|criteri/i.test(msg)) return { kind: "invalid-output", retryAt: null };
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|overloaded|\b5\d\d\b|socket hang up|SIGTERM|killed/i.test(msg)) return { kind: "transient", retryAt: null };
  return { kind: "unknown", retryAt: null };
}
