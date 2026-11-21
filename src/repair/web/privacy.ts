// src/repair/web/privacy.ts
// La evidencia de la web se construye por campos permitidos: nombres de job/paso y LÍNEAS DE
// ERROR saneadas, nunca un log entero. Las webs de boda son privadas: nada de URLs, rutas web
// (/<slug>), correos, ids largos ni secretos llega al modelo, a un PR o a un aviso.
import { redactText } from "../../privacy/outboundPolicy";
import { ERROR_LINE_RE } from "./classify";

export function sanitizeLine(raw: string): string {
  return redactText(raw)
    .replace(/^\S+\t\S+\t/, "") // «job\tpaso\t» de gh run view --log
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/postgres(ql)?:\/\/\S+/gi, "<url-bd>")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\b(Bearer|token|key|secret|password|cookie)[=: ]+\S+/gi, "$1 <redactado>")
    .replace(/\b(re|sk|pk|rk|whsec)_[A-Za-z0-9_]{8,}\b/g, "<redactado>")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "<id>")
    .replace(/\/(home|Users)\/[^\s'"`)]+/g, "<ruta>")
    // rutas web sin extensión (/algo, /a/b): pueden ser el slug de una boda
    .replace(/(^|[\s"'`(=])\/(?![\s/])[^\s"'`)?.,:;]*(?=$|[\s"'`)?,:;])/g, "$1<ruta-web>")
    .slice(0, 300);
}

/** Líneas de error útiles de un log de pasos fallidos: saneadas, sin repetidas, como mucho `max`. */
export function errorLines(log: string, max = 60): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = log.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (!ERROR_LINE_RE.test(lines[i])) continue;
    // la línea de error y las 2 siguientes (suelen llevar el fichero y la línea)
    for (const l of lines.slice(i, i + 3)) {
      const s = sanitizeLine(l).trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out.slice(0, max);
}

/** Texto libre (diagnóstico del modelo, motivos) apto para un aviso o un PR. */
export function safeText(text: string, max = 400): string {
  return text
    .split("\n")
    .map((l) => sanitizeLine(l))
    .join("\n")
    .slice(0, max);
}
