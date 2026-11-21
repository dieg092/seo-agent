// src/repair/web/classify.ts
// Clasificación determinista de los fallos de la web (wedding-invite-2 y miwebdeboda-deploy)
// antes de gastar cupo del modelo (plan de Codex para la autorreparación web, 2026-11-21).
// Lo que no se puede decidir con seguridad NO se trata como código.
import { createHash } from "node:crypto";

export type WebKind = "transient" | "founder" | "external" | "code";

/** Fuentes vigiladas: workflow de GitHub Actions por componente. */
export interface WebSource {
  component: string;
  repo: string;
  workflow: string;
  /** Solo ejecuciones de esta rama (vacío = cualquiera). */
  branch?: string;
  /** El código que falla está en wi2 y un agente puede repararlo. */
  repairable: boolean;
  /** Relanzar en un transitorio: «rerun» (mismos jobs fallidos) o «dispatch» (nueva ejecución). */
  retry: "rerun" | "dispatch" | "none";
}

export const APP_REPO = "dieg092/wedding-invite-2";
export const DEPLOY_REPO = "dieg092/miwebdeboda-deploy";

export const WEB_SOURCES: WebSource[] = [
  { component: "web-ci", repo: APP_REPO, workflow: "ci.yml", branch: "main", repairable: true, retry: "rerun" },
  { component: "web-lighthouse", repo: APP_REPO, workflow: "lighthouse.yml", branch: "main", repairable: true, retry: "rerun" },
  // deploy.yml: relanzar una ejecución antigua lo rechaza la puerta (runningSha); se lanza de nuevo.
  { component: "web-deploy", repo: DEPLOY_REPO, workflow: "deploy.yml", branch: "main", repairable: true, retry: "dispatch" },
  { component: "web-health", repo: DEPLOY_REPO, workflow: "health-checks.yml", branch: "main", repairable: true, retry: "rerun" },
  { component: "web-monitor", repo: DEPLOY_REPO, workflow: "monitor-sintetico.yml", branch: "main", repairable: true, retry: "rerun" },
  { component: "web-stripe-live", repo: DEPLOY_REPO, workflow: "stripe-live.yml", branch: "main", repairable: false, retry: "rerun" },
];

export interface WebFailure {
  component: string;
  conclusion: string;
  /** «job :: paso» de cada paso fallido. */
  failedSteps: string[];
  /** Líneas de error ya saneadas (ver privacy.ts). */
  lines: string[];
}

export interface WebClassification {
  kind: WebKind;
  signature: string;
  founderStep?: string;
  /** Motivo corto y sin datos privados, para el log y los avisos. */
  reason: string;
}

const TRANSIENT_RE =
  /\b(502|503|504)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|runner has received a shutdown signal|lost communication with the server|The operation was canceled|exceeded the maximum execution time|Service Unavailable|Internal server error occurred|rate limit|secondary rate limit|lanza el despliegue de nuevo|no ha terminado en verde|Could not resolve host|npm ERR! network|ERR_PNPM_META_FETCH_FAIL|Can't reach database server/i;

const CREDENTIAL_RE =
  /\b(401|403)\b|Bad credentials|invalid_grant|unauthori[sz]ed|token (has )?expired|PERMISSION_DENIED|authentication failed|password authentication failed|falta (APP_READ_TOKEN|el GITHUB_TOKEN|APP_REPO)|Resource not accessible by integration/i;

/** Rechazos de la puerta de despliegue que solo resuelve el propietario (huella, tests, historial). */
const GATE_FOUNDER_RE = /aprobar\.sh (huella|commit)|huella|no es el propietario|solo valen push o fusión de PR del propietario|historial reescrito|se debilitan los tests|no dice quién llevó main/i;

/** Proveedores externos con respuesta inequívoca: no es código de la web. */
const EXTERNAL_RULES: { re: RegExp; step: string; reason: string }[] = [
  {
    re: /spending limit needs to be increased|recent account payments have failed/i,
    reason: "GitHub no arranca el job por el límite de gasto de Actions",
    step: "GitHub no arranca este job porque la cuenta ha llegado a su límite de gasto de Actions (solo afecta a los workflows que usan máquinas de GitHub; la CI y el despliegue van en el runner del Mac y no gastan). No pagues nada: abre Claude Code y dile «pasa al runner del Mac el workflow que no arranca»; te dará una huella para aprobar.",
  },
  {
    re: /last_event=delivery_delayed|no alcanzó un estado de entrega/i,
    reason: "el correo canario se envía pero el buzón de destino lo retrasa",
    step:
      "Resend envía el correo canario pero el buzón que lo recibe lo está retrasando (estado delivery_delayed): no es un fallo de la web. Entra en el buzón del canario (el de SYNTHETIC_MONITOR_EMAIL), comprueba que no esté lleno ni marque los correos de miwebdeboda.com como spam, vacíalo si hace falta y marca el último canario como «no es spam». Después no tienes que hacer nada más: el chequeo de mañana lo confirmará solo.",
  },
  {
    re: /last_event=(bounced|complained)/i,
    reason: "el correo canario rebota",
    step: "El correo canario rebota en el buzón de destino. Comprueba que la dirección de SYNTHETIC_MONITOR_EMAIL sigue existiendo; si la cambias, actualiza el secreto con: gh secret set SYNTHETIC_MONITOR_EMAIL -R dieg092/miwebdeboda-deploy (escríbelo cuando lo pida, sin pegarlo en ningún chat).",
  },
  {
    re: /api\.stripe\.com.*\b5\d\d\b|StripeConnectionError|StripeAPIError/i,
    reason: "Stripe responde con error",
    step: "Stripe está respondiendo con errores. Mira https://status.stripe.com; si está caído no hay que hacer nada, el monitor lo comprobará de nuevo mañana.",
  },
];

const HOUR = 3_600_000;

/** Firma estable: componente, pasos y errores sin datos variables. */
export function webSignature(f: Pick<WebFailure, "component" | "failedSteps" | "lines">): string {
  const norm = (s: string) =>
    s
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "#")
      .replace(/\b[0-9a-f]{7,}\b/gi, "#")
      .replace(/\d+(\.\d+)?/g, "#")
      .replace(/\s+/g, " ")
      .trim();
  const errs = f.lines.filter((l) => ERROR_LINE_RE.test(l)).slice(0, 3).map(norm);
  return [f.component, ...[...f.failedSteps].sort().map(norm), ...errs].join(" | ").slice(0, 300);
}

/** Líneas que identifican un error (para la firma y para la evidencia). */
export const ERROR_LINE_RE = /error TS\d+|^\s*(not ok|✘|✖|×)\s|\berror\b.*\(|AssertionError|Expected|Received|Error:|##\[error\]|::error::|failed|FAIL\b|Timeout .*exceeded|budget|excede|supera/i;

export function classifyWebFailure(f: WebFailure): WebClassification {
  const signature = webSignature(f);
  const text = `${f.failedSteps.join("\n")}\n${f.lines.join("\n")}`;
  if (f.conclusion === "cancelled" || f.conclusion === "timed_out" || f.conclusion === "startup_failure") {
    return { kind: "transient", signature, reason: `ejecución ${f.conclusion}` };
  }
  if (f.component === "web-deploy" && GATE_FOUNDER_RE.test(text)) {
    return {
      kind: "founder",
      signature,
      reason: "la puerta de despliegue necesita tu aprobación",
      founderStep:
        "El despliegue está parado porque la puerta pide tu aprobación (huella de ficheros protegidos o tests cambiados). Revisa y aprueba el HEAD de main: cd ~/Projects/infra/miwebdeboda-deploy && bash scripts/aprobar.sh huella $(gh api repos/dieg092/wedding-invite-2/commits/main --jq .sha) y después: gh workflow run deploy.yml -R dieg092/miwebdeboda-deploy",
    };
  }
  if (CREDENTIAL_RE.test(text)) {
    return {
      kind: "founder",
      signature,
      reason: "una credencial ha sido rechazada",
      founderStep: `Una credencial que usa ${f.component} ha sido rechazada o ha caducado. Renuévala en su servicio y guárdala con gh secret set <NOMBRE> -R <repo> (escribiéndola cuando lo pida, sin pegarla en ningún chat); el supervisor comprobará solo que vuelve a funcionar.`,
    };
  }
  for (const r of EXTERNAL_RULES) if (r.re.test(text)) return { kind: "external", signature, reason: r.reason, founderStep: r.step };
  if (TRANSIENT_RE.test(text)) return { kind: "transient", signature, reason: "fallo de red o de infraestructura" };
  if (!f.failedSteps.length) return { kind: "transient", signature, reason: "falló sin paso identificable" };
  return { kind: "code", signature, reason: `falla ${f.failedSteps.slice(0, 2).join(", ")}` };
}

/** Clave de incidencia web (prefijo propio para no chocar con las de seo-agent). */
export function webIncidentKey(component: string, signature: string): string {
  return createHash("sha256").update(`web-v1|${component}|${signature}`).digest("hex").slice(0, 24);
}

/** Un fallo que desaparece al relanzar es intermitente; si vuelve 3 veces en 14 días hay que arreglarlo. */
export const FLAKY = { occurrences: 3, windowMs: 14 * 24 * HOUR };

/** Un externo que dura más de 30 min se avisa (una vez); antes se espera. */
export const EXTERNAL_NOTIFY_AFTER_MS = 30 * 60_000;
