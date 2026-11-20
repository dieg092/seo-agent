// src/repair/classify.ts
// Clasificación determinista de los avisos de seo-agent antes de gastar cupo del modelo
// (plan de Codex para la autorreparación, punto 3). Solo entran los avisos de FALLOS DEL
// PROPIO SISTEMA; los de producto (tareas SEO, backlinks, graduaciones, frenos…) ya tienen
// su dueño y se ignoran. Lo desconocido no se repara.
import { createHash } from "node:crypto";
import { redactText } from "../privacy/outboundPolicy";

export type FaultKind = "ignore" | "transient" | "founder" | "code";

export interface AlertInput {
  type: string;
  subject: string;
  body: string;
}

export interface Classification {
  kind: FaultKind;
  component: string;
  signature: string;
  /** Qué tiene que hacer el fundador (solo kind = founder). */
  founderStep?: string;
}

/** Avisos de fallo del sistema que pueden ser de código o de configuración de seo-agent. */
const CODE_TYPES = new Set([
  "workflow-failed",
  "seo-bridge-contract-rejected",
  "editorial-battery-invalid",
  "gsc-full-fetch-error",
  "url-inspection-error",
]);

/** Avisos de sistema que NO se reparan con código: se queda el aviso que ya llegó a Telegram. */
const NOT_CODE_TYPES = new Set([
  // calibración invertida: arreglarla es tocar la rúbrica o los umbrales, prohibido
  "editorial-calibration-inverted",
  "editorial-disabled",
  "url-inspection-quota",
]);

const TRANSIENT_RE =
  /\b(429|500|502|503|504)\b|service is currently unavailable|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|P1001|P1002|P1017|Can't reach database server|rate limit|Too Many Requests/i;

const CREDENTIAL_RE =
  /\b(401|403)\b|invalid_grant|unauthori[sz]ed|bad credentials|token (has )?expired|PERMISSION_DENIED|authentication failed|password authentication failed|P1000|requires? (a )?(huella|fingerprint)/i;

export function isRepairOwnAlert(type: string): boolean {
  return type.startsWith("seo-repair-");
}

/** Componente afectado: el workflow entre comillas del asunto o el prefijo del tipo. */
export function componentOf(a: AlertInput): string {
  const quoted = /"([a-z0-9-]+)"/i.exec(a.subject)?.[1];
  if (a.type === "workflow-failed" && quoted) return quoted;
  if (a.type.startsWith("editorial-")) return "editorial-battery";
  return a.type.replace(/-(failed|error|contract-rejected)$/, "");
}

/** Firma sin datos variables ni privados: ids, números, URLs y rutas fuera. */
export function signatureOf(a: AlertInput): string {
  const text = redactText(`${a.subject}\n${a.body}`)
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\/Users\/[^\s'"`)]+/g, "<ruta>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#")
    .replace(/\b[0-9a-f]{7,}\b/gi, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, 200);
}

export function incidentKey(alertType: string, component: string, signature: string): string {
  return createHash("sha256").update(`v1|${alertType}|${component}|${signature}`).digest("hex").slice(0, 24);
}

export function classifyAlert(a: AlertInput): Classification {
  const component = componentOf(a);
  const signature = signatureOf(a);
  const ignore: Classification = { kind: "ignore", component, signature };
  if (isRepairOwnAlert(a.type)) return ignore;

  const isSystemFault = CODE_TYPES.has(a.type) || NOT_CODE_TYPES.has(a.type) || /-(failed|error)$/.test(a.type);
  if (!isSystemFault) return ignore;

  const text = `${a.subject}\n${a.body}`;
  if (CREDENTIAL_RE.test(text)) {
    return {
      kind: "founder",
      component,
      signature,
      founderStep: `Una credencial de ${component} ha sido rechazada. Renueva ese secreto como siempre (con read -rs, sin pegarlo en ningún chat) y relanza el proceso; el supervisor comprobará solo que vuelve a funcionar.`,
    };
  }
  if (TRANSIENT_RE.test(text)) return { kind: "transient", component, signature };
  if (NOT_CODE_TYPES.has(a.type)) return ignore;
  return { kind: "code", component, signature };
}

/** Un «transitorio» que se repite durante horas ya no es transitorio: falta un reintento o algo peor. */
export const PERSISTENT_TRANSIENT = { occurrences: 4, spanHours: 6 };

export function promoteTransient(occurrences: number, firstSeenAt: Date, lastSeenAt: Date): boolean {
  return (
    occurrences >= PERSISTENT_TRANSIENT.occurrences &&
    lastSeenAt.getTime() - firstSeenAt.getTime() >= PERSISTENT_TRANSIENT.spanHours * 3_600_000
  );
}
