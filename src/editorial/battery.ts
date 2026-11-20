// src/editorial/battery.ts
// Batería de defectos (planes de Codex, pasos 4 y de eficiencia): la guarda editorial completa,
// con el modelo real, sobre 20 casos sintéticos con defectos conocidos. Sin una batería aprobada y
// vigente para la configuración actual (configKey), la guarda retiene.
//
// Eficiencia: incremental y reanudable. Cada respuesta del modelo y cada resultado de caso se
// guardan al momento; una ejecución cortada sigue donde se quedó sin repetir llamadas. Primero los
// casos deterministas (sin llamadas), luego los críticos y luego el resto, con corte en cuanto un
// crítico se escapa o ya no se puede llegar al 90 %. Una llamada cada vez, con presupuesto diario.
//
// Terminación (ningún reintento es infinito):
//   - cupo/presupuesto/Órbita ocupada: espera a la hora indicada (no cuenta como fallo); como mucho
//     MAX_QUOTA_HITS límites de cupo por ejecución;
//   - errores técnicos: MAX_TRANSIENT seguidos (esperas 1, 2, 4 h);
//   - una ejecución vive RUN_MAX_DAYS días;
//   → si se pasa cualquiera: disabled-resource.
//   - fallos de calidad reales: MAX_QUALITY_ATTEMPTS por configKey (esperas 6 y 12 h) → disabled-quality.
// Un estado disabled-* es terminal para esa configKey: solo una configuración nueva (rúbrica, prompt,
// modelo o reglas) vuelve a intentarlo. Nunca se tocan umbrales, rúbrica ni casos automáticamente.
// Avisa una vez por (configKey, estado). El resto del SEO sigue funcionando.
import { createHash } from "node:crypto";
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import type { Runner } from "./evaluator";
import { budgetedRunner } from "./budget";
import { classifyModelError } from "./modelErrors";
import { deterministicBlock, editorialConfigKey, pairedDecision, scoreVersion, type VersionScore } from "./paired";
import { CRITERION_FLOOR, CRITERION_KEYS } from "./rubric";
import { BASE_ARTICLE, BATTERY_FACTS, BATTERY_CASES, BATTERY_MIN_RATE, BATTERY_SLUG, BATTERY_VERSION, type BatteryCase } from "./fixtures/validationCases";

export const BATTERY_MAX_AGE_DAYS = 30;
export const MAX_QUALITY_ATTEMPTS = 3;
export const QUALITY_BACKOFF_HOURS = [6, 12];
export const MAX_TRANSIENT = 3;
export const MAX_QUOTA_HITS = 7;
export const RUN_MAX_DAYS = 21;
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TERMINAL = ["disabled-quality", "disabled-resource"];

export const batteryKey = () => createHash("sha256").update(`${BATTERY_VERSION}|${editorialConfigKey()}`).digest("hex").slice(0, 16);

export type BatteryState = { status: "ok"; at: Date } | { status: "missing" | "running" | "stale" | "failed" | "disabled"; reason: string };

async function terminalRun(key: string) {
  return prisma.editorialBatteryRun.findFirst({ where: { configKey: key, status: { in: TERMINAL } }, orderBy: { createdAt: "desc" } });
}

export async function batteryState(now: Date): Promise<BatteryState> {
  const key = batteryKey();
  const dead = await terminalRun(key);
  if (dead) return { status: "disabled", reason: `IA editorial desactivada para esta configuración (${dead.status === "disabled-quality" ? "la batería de defectos no pasa" : "no hay recursos para terminar la batería"})` };
  const last = await prisma.editorialBattery.findFirst({ where: { configKey: key }, orderBy: { createdAt: "desc" } });
  if (last?.passed && now.getTime() - last.createdAt.getTime() <= BATTERY_MAX_AGE_DAYS * DAY) return { status: "ok", at: last.createdAt };
  const running = await prisma.editorialBatteryRun.findFirst({ where: { configKey: key, status: "running" } });
  if (running) return { status: "running", reason: "la batería de defectos está en curso" };
  if (!last) return { status: "missing", reason: "falta la batería de defectos para esta configuración" };
  if (!last.passed) return { status: "failed", reason: `la batería de defectos no pasa (${last.detected}/${last.total}, ${last.criticalMissed} críticos sin detectar)` };
  return { status: "stale", reason: "la batería de defectos ha caducado" };
}

/** ¿Hay trabajo de batería que hacer ya? (sin llamar al modelo) */
export async function batteryDue(now: Date): Promise<boolean> {
  const key = batteryKey();
  if (await terminalRun(key)) return false;
  const running = await prisma.editorialBatteryRun.findFirst({ where: { configKey: key, status: "running" } });
  if (running) return !running.nextAttemptAt || running.nextAttemptAt <= now;
  const lastPass = await prisma.editorialBattery.findFirst({ where: { configKey: key, passed: true }, orderBy: { createdAt: "desc" } });
  if (lastPass && now.getTime() - lastPass.createdAt.getTime() <= BATTERY_MAX_AGE_DAYS * DAY) return false;
  const lastFail = await prisma.editorialBatteryRun.findFirst({ where: { configKey: key, status: "failed-quality" }, orderBy: { createdAt: "desc" } });
  return !lastFail?.nextAttemptAt || lastFail.nextAttemptAt <= now;
}

/** La batería pasa si detecta todos los críticos y al menos BATTERY_MIN_RATE del total. */
export function batteryPasses(results: { critical: boolean; detected: boolean }[]): { passed: boolean; detected: number; criticalMissed: number } {
  const detected = results.filter((r) => r.detected).length;
  const criticalMissed = results.filter((r) => r.critical && !r.detected).length;
  return { passed: criticalMissed === 0 && detected / results.length >= BATTERY_MIN_RATE, detected, criticalMissed };
}

/** ¿Ya está decidido sin evaluar el resto? */
export function earlyVerdict(done: { critical: boolean; detected: boolean }[], total: number): "failed" | null {
  if (done.some((r) => r.critical && !r.detected)) return "failed";
  const missed = done.filter((r) => !r.detected).length;
  return (total - missed) / total < BATTERY_MIN_RATE ? "failed" : null;
}

/** Orden: críticos primero (por tipo), luego el resto. */
export function modelOrder(cases: BatteryCase[]): BatteryCase[] {
  return [...cases.filter((c) => c.critical), ...cases.filter((c) => !c.critical)];
}

async function alertOnce(key: string, state: string, body: string, alert: typeof recordAlert) {
  const invalid = state === "invalid-base";
  const type = invalid ? "editorial-battery-invalid" : "editorial-disabled";
  const subject = invalid
    ? `Batería editorial no válida (configuración ${key.slice(0, 8)})`
    : `IA editorial desactivada (${state}, configuración ${key.slice(0, 8)})`;
  if (await prisma.alert.findFirst({ where: { type, subject } })) return;
  for (let i = 0; i < 3; i++) {
    try {
      await alert({ type, subject, body });
      return;
    } catch {
      // se reintenta la entrega; si no, se sigue sin bloquear
    }
  }
}

/** Runner que guarda cada respuesta: una ejecución cortada no vuelve a pedirla. */
function persistent(runId: string, caseId: string, side: string, inner: Runner): Runner {
  let i = 0;
  return async (req) => {
    const sampleIndex = i++;
    const saved = await prisma.editorialBatterySample.findUnique({ where: { runId_caseId_side_sampleIndex: { runId, caseId, side, sampleIndex } } });
    if (saved) return saved.raw as never;
    const raw = await inner(req);
    await prisma.editorialBatterySample.create({ data: { runId, caseId, side, sampleIndex, raw: raw as object } });
    return raw;
  };
}

export interface BatteryDeps {
  alert?: typeof recordAlert;
  busy?: () => boolean;
  /** Para los tests: un runner sin presupuesto. */
  unbudgeted?: boolean;
}

/** Un paso de la batería: avanza lo que pueda y devuelve una nota. Idempotente. */
export async function stepBattery(runner: Runner, now: Date, siteBase: string, deps: BatteryDeps = {}): Promise<string> {
  const alert = deps.alert ?? recordAlert;
  const key = batteryKey();
  const dead = await terminalRun(key);
  if (dead) return `batería de defectos: desactivada (${dead.status}); solo se reintenta con otra configuración`;

  let run = await prisma.editorialBatteryRun.findFirst({ where: { configKey: key, status: "running" } });
  if (!run) {
    const lastPass = await prisma.editorialBatteryRun.findFirst({ where: { configKey: key, status: "passed" }, orderBy: { createdAt: "desc" } });
    const fails = await prisma.editorialBatteryRun.findMany({ where: { configKey: key, status: "failed-quality", createdAt: { gt: lastPass?.createdAt ?? new Date(0) } }, orderBy: { createdAt: "desc" } });
    if (fails[0]?.nextAttemptAt && fails[0].nextAttemptAt > now) return `batería de defectos: siguiente intento a partir de ${fails[0].nextAttemptAt.toISOString()}`;
    run = await prisma.editorialBatteryRun.create({ data: { configKey: key, attempt: fails.length + 1, status: "running", startedAt: now } });
  }
  if (run.nextAttemptAt && run.nextAttemptAt > now) return `batería de defectos: en espera hasta ${run.nextAttemptAt.toISOString()}`;
  const runId = run.id;
  const disable = async (why: string) => {
    await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { status: "disabled-resource", finishedAt: now, detail: { why } } });
    await alertOnce(key, "disabled-resource", `La batería de defectos no se puede terminar (${why}). La IA editorial queda desactivada para esta configuración; las mejoras de artículos no se fusionan y el resto del SEO sigue. Se vuelve a intentar sola si cambia el modelo, la rúbrica, el prompt o las reglas.`, alert);
    return `batería de defectos: desactivada (${why})`;
  };
  if (now.getTime() - run.startedAt.getTime() > RUN_MAX_DAYS * DAY) return disable(`${RUN_MAX_DAYS} días sin terminar`);

  const results = async () => prisma.editorialBatteryCaseResult.findMany({ where: { runId } });
  const record = async (c: BatteryCase, detected: boolean, reason: string) =>
    prisma.editorialBatteryCaseResult.upsert({ where: { runId_caseId: { runId, caseId: c.id } }, create: { runId, caseId: c.id, critical: c.critical, detected, reason }, update: {} });

  // 1. Deterministas: sin llamadas.
  const doneIds = new Set((await results()).map((r) => r.caseId));
  for (const c of BATTERY_CASES) {
    if (doneIds.has(c.id)) continue;
    const blocked = deterministicBlock(BASE_ARTICLE, c.head, c.id, BATTERY_FACTS);
    if (blocked) await record(c, true, blocked);
  }

  const finish = async (): Promise<string> => {
    const rs = await results();
    const verdict = batteryPasses(rs);
    const complete = rs.length === BATTERY_CASES.length;
    const passed = complete && verdict.passed;
    const base = (await prisma.editorialBatterySample.findMany({ where: { runId, caseId: "__base__" } })).length;
    await prisma.editorialBattery.create({
      data: { configKey: key, passed, detected: verdict.detected, total: BATTERY_CASES.length, criticalMissed: verdict.criticalMissed, detail: { runId, baseSamples: base, results: rs.map((r) => ({ id: r.caseId, critical: r.critical, detected: r.detected, reason: r.reason })) } as object, createdAt: now },
    });
    const missed = rs.filter((r) => !r.detected).map((r) => r.caseId);
    if (passed) {
      await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { status: "passed", finishedAt: now } });
      return `batería de defectos: pasa (${verdict.detected}/${BATTERY_CASES.length})`;
    }
    if (run!.attempt >= MAX_QUALITY_ATTEMPTS) {
      await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { status: "disabled-quality", finishedAt: now } });
      await alertOnce(key, "disabled-quality", `La batería de defectos ha fallado ${MAX_QUALITY_ATTEMPTS} veces con esta configuración (se le escapan: ${missed.join(", ")}). La IA editorial queda desactivada: las mejoras de artículos no se fusionan y el resto del SEO sigue. No se cambian umbrales ni casos; se vuelve a intentar sola si cambia el modelo, la rúbrica, el prompt o las reglas.`, alert);
      return `batería de defectos: no pasa por ${MAX_QUALITY_ATTEMPTS}.ª vez, IA editorial desactivada`;
    }
    const wait = QUALITY_BACKOFF_HOURS[run!.attempt - 1] * HOUR;
    await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { status: "failed-quality", finishedAt: now, nextAttemptAt: new Date(now.getTime() + wait) } });
    return `batería de defectos: no pasa (intento ${run!.attempt}/${MAX_QUALITY_ATTEMPTS}; se le escapan: ${missed.join(", ")})`;
  };

  // Base no válida: cuenta como intento fallido de calidad (mismas esperas y mismo tope de 3).
  const finishInvalid = async (why: string): Promise<string> => {
    await prisma.editorialBattery.create({ data: { configKey: key, passed: false, detected: 0, total: BATTERY_CASES.length, criticalMissed: 0, detail: { runId, invalid: why } as object, createdAt: now } });
    if (run!.attempt >= MAX_QUALITY_ATTEMPTS) {
      await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { status: "disabled-quality", finishedAt: now } });
      await alertOnce(key, "disabled-quality", `La batería de defectos no es válida ${MAX_QUALITY_ATTEMPTS} veces seguidas: ${why}. La IA editorial queda desactivada para esta configuración; el resto del SEO sigue.`, alert);
      return `batería de defectos: ${why}; IA editorial desactivada`;
    }
    await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { status: "failed-quality", finishedAt: now, nextAttemptAt: new Date(now.getTime() + QUALITY_BACKOFF_HOURS[run!.attempt - 1] * HOUR) } });
    // Un artículo base inválido no se arregla repitiendo: se avisa ya, no al quedar desactivada.
    await alertOnce(key, "invalid-base", `La batería de defectos no es válida (intento ${run!.attempt}/${MAX_QUALITY_ATTEMPTS}): ${why}. Repetir no lo arregla; hay que revisar el artículo base antes de que se agoten los intentos.`, alert);
    return `batería de defectos: no vale (${why}; intento ${run!.attempt}/${MAX_QUALITY_ATTEMPTS})`;
  };

  const rs0 = await results();
  if (earlyVerdict(rs0, BATTERY_CASES.length) || rs0.length === BATTERY_CASES.length) return finish();

  // 2. Con el modelo: críticos primero, una llamada cada vez, todo guardado al momento.
  const model = deps.unbudgeted ? runner : budgetedRunner(runner, "background", () => now, { busy: deps.busy });
  const url = `${siteBase}/blog/${BATTERY_SLUG}`;
  try {
    const base: VersionScore = await scoreVersion({ url, md: BASE_ARTICLE, siteBase, runner: persistent(runId, "__base__", "base", model) }, "base");
    // Ningún criterio del artículo base por debajo del suelo: si no, cualquier cambio se bloquearía por
    // carencias de la base y la batería no mediría si se detectan los defectos.
    const weak = CRITERION_KEYS.filter((k) => base.evals.some((e) => e.criteria[k].score < CRITERION_FLOOR));
    if (weak.length) {
      await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { detail: { invalidBase: { score: base.score, weak } } } });
      return finishInvalid(`el artículo base tiene criterios por debajo de ${CRITERION_FLOOR}: ${weak.join(", ")}`);
    }
    for (const c of modelOrder(BATTERY_CASES)) {
      if ((await results()).some((r) => r.caseId === c.id)) continue;
      const d = await pairedDecision({ url, label: c.id, baseMd: BASE_ARTICLE, headMd: c.head, siteBase, runner: persistent(runId, c.id, "head", model), base, facts: BATTERY_FACTS });
      await record(c, !d.approve, d.reason);
      if (run.transientFails > 0) run = await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { transientFails: 0 } });
      if (earlyVerdict(await results(), BATTERY_CASES.length)) return finish();
    }
  } catch (e) {
    const c = classifyModelError(e, now);
    if (c.kind === "budget" || c.kind === "busy") {
      await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { nextAttemptAt: c.retryAt } });
      return `batería de defectos: en pausa hasta ${c.retryAt!.toISOString()} (${c.kind === "busy" ? "Órbita usa el modelo" : "presupuesto de hoy gastado"})`;
    }
    if (c.kind === "quota") {
      const hits = run.quotaHits + 1;
      if (hits > MAX_QUOTA_HITS) return disable(`${hits} límites de cupo en la misma ejecución`);
      await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { quotaHits: hits, nextAttemptAt: c.retryAt } });
      return `batería de defectos: cupo del modelo agotado, sigue a partir de ${c.retryAt!.toISOString()}`;
    }
    if (c.kind === "permanent-model-error") return disable("el modelo no está disponible");
    const fails = run.transientFails + 1;
    if (fails > MAX_TRANSIENT) return disable(`${fails} errores técnicos seguidos`);
    const retryAt = new Date(now.getTime() + 2 ** (fails - 1) * HOUR);
    await prisma.editorialBatteryRun.update({ where: { id: runId }, data: { transientFails: fails, nextAttemptAt: retryAt } });
    return `batería de defectos: error técnico (${c.kind}, ${fails}/${MAX_TRANSIENT}), reintento a partir de ${retryAt.toISOString()}`;
  }
  return finish();
}
