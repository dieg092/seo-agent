// src/editorial/gate.ts
// La IA editorial aprueba o bloquea sola las mejoras de artículos (B5: sin el fundador).
// Va en la guarda premerge de la operación content-improve, después de las comprobaciones
// generales (alcance, etiquetas, freno). Por orden:
//   - calibración en verde y vigente (deriva, inversión clara o artículo trampa la suspenden);
//   - batería de defectos aprobada y vigente para esta configuración (battery.ts);
//   - el PR cambia exactamente el fichero de contenido del artículo del contrato;
//   - decisión por parejas main/rama (paired.ts); el mismo par de textos da siempre la misma;
//   - y, si aprueba, una plaza en el piloto editorial medido (pilot.ts). Sin plaza, se retiene
//     (no se bloquea): Órbita lo vuelve a intentar y la plaza se libera sola.
// La correlación nota–GSC entre artículos es solo diagnóstico: no autoriza ni retiene.
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { ALLOW, BLOCK, HOLD, type GuardDecision } from "../bridge/guard";
import { contentFromSource } from "./article";
import { EVALUATOR_MODEL, type Runner } from "./evaluator";
import { RUBRIC_VERSION } from "./rubric";
import { editorialConfigKey, pairedDecision } from "./paired";
import { batteryState } from "./battery";
import { reservePilot } from "./pilot";

export { MIN_IMPROVEMENT, DISAGREEMENT } from "./paired";
/** Una calibración vale 35 días (se rehace cada 30). */
export const CALIBRATION_MAX_AGE_DAYS = 35;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTENT_FILE = /^src\/lib\/blog\/content\/([a-z0-9-]+)\/([a-z0-9-]+)\.ts$/;

export interface GateInput {
  files: string[];
  contractUrls: string[];
  baseRef: string;
  headRef: string;
  siteBase: string;
  /** Contenido de un fichero del repositorio en una referencia; null si no existe. */
  readFile: (path: string, ref: string) => Promise<string | null>;
  runner: Runner;
  now: Date;
  /** Tarea de Órbita del PR: la plaza del piloto se reserva a su nombre. */
  orbitaTaskId?: string;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/** Clave de la caché de la guarda: textos de main y de la rama y toda la configuración que decide. */
export function gateCacheKey(baseText: string, headText: string): string {
  return hash([editorialConfigKey(), hash(baseText), hash(headText)].join("|"));
}

export async function editorialGate(g: GateInput): Promise<GuardDecision> {
  const calibration = await prisma.editorialCalibration.findFirst({ orderBy: { createdAt: "desc" } });
  if (calibration?.status !== "ok") return { code: HOLD, reason: `IA editorial suspendida (calibración ${calibration?.status ?? "pendiente"})` };
  if (g.now.getTime() - calibration.createdAt.getTime() > CALIBRATION_MAX_AGE_DAYS * DAY_MS) return { code: HOLD, reason: "IA editorial: la calibración ha caducado" };
  const battery = await batteryState(g.now);
  if (battery.status !== "ok") return { code: HOLD, reason: `IA editorial: ${battery.reason}` };

  const content = g.files.filter((f) => CONTENT_FILE.test(f));
  if (content.length !== 1) return { code: BLOCK, reason: `el PR tiene que cambiar el contenido de un solo artículo (cambia ${content.length})` };
  const [, cat, name] = CONTENT_FILE.exec(content[0])!;
  const slug = `${cat}/${name}`;
  const url = `${g.siteBase}/blog/${slug}`;
  if (!g.contractUrls.includes(url)) return { code: BLOCK, reason: `el artículo cambiado (${slug}) no es el del contrato` };

  const [baseSrc, headSrc] = await Promise.all([g.readFile(content[0], g.baseRef), g.readFile(content[0], g.headRef)]);
  const baseMd = baseSrc && contentFromSource(baseSrc);
  const headMd = headSrc && contentFromSource(headSrc);
  if (!baseMd || !headMd) return { code: BLOCK, reason: `no se puede leer el texto de ${slug} en main o en la rama` };

  const gateKey = gateCacheKey(baseMd, headMd);
  const cached = await prisma.editorialScore.findFirst({ where: { slug, contentHash: gateKey, kind: "gate" }, orderBy: { createdAt: "desc" } });
  let approve: boolean;
  let reason: string;
  if (cached) {
    approve = cached.decision === "approve";
    reason = `(ya evaluado) ${cached.reason}`;
  } else {
    const d = await pairedDecision({ url, label: slug, baseMd, headMd, siteBase: g.siteBase, runner: g.runner });
    approve = d.approve;
    reason = d.reason;
    if (d.evaluated && d.base && d.head) {
      const common = { slug, url, rubricVersion: RUBRIC_VERSION, model: EVALUATOR_MODEL, createdAt: g.now };
      const [b0, h0] = [d.base.evals[0], d.head.evals[0]];
      await prisma.editorialScore.create({
        data: { ...common, contentHash: hash(baseMd), kind: "gate-base", score: b0.score, finalScore: d.base.score, decision: "baseline", reason: "versión de main en la guarda", criteria: b0.criteria as object, deterministic: { evals: d.base.evals.map((e) => e.score) }, summary: b0.summary },
      });
      await prisma.editorialScore.create({
        data: { ...common, contentHash: gateKey, kind: "gate", score: h0.score, finalScore: d.head.score, decision: approve ? "approve" : "block", reason, criteria: h0.criteria as object, deterministic: { evals: d.head.evals.map((e) => e.score), gain: d.gain }, summary: h0.summary },
      });
    }
  }
  if (!approve) return { code: BLOCK, reason: `IA editorial ${reason}` };

  // Aprobada: solo se fusiona dentro del piloto medido.
  if (!g.orbitaTaskId) return { code: HOLD, reason: `IA editorial ${reason}; falta la tarea para reservar plaza en el piloto` };
  const seat = await reservePilot({ orbitaTaskId: g.orbitaTaskId, page: url }, g.now);
  if (!seat.ok) return { code: HOLD, reason: `IA editorial ${reason}; retenida: ${seat.reason}` };
  return { code: ALLOW, reason: `IA editorial ${reason} (${seat.note})` };
}
