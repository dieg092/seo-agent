// src/editorial/battery.ts
// Batería de defectos (plan de Codex, paso 4): la guarda editorial completa, con el modelo real,
// sobre 20 casos sintéticos con defectos conocidos. Sin una batería aprobada y vigente para la
// configuración actual (rúbrica, prompt, modelo y reglas de la guarda), la guarda retiene.
//   - vale BATTERY_MAX_AGE_DAYS días; si cambia la configuración, deja de valer al instante;
//   - si falla, se reintenta sola cada BATTERY_RETRY_HOURS (la guarda sigue reteniendo).
import { createHash } from "node:crypto";
import { prisma } from "../db";
import type { Runner } from "./evaluator";
import { editorialConfigKey, pairedDecision, scoreVersion } from "./paired";
import { BASE_ARTICLE, BATTERY_CASES, BATTERY_MIN_RATE, BATTERY_SLUG, BATTERY_VERSION } from "./fixtures/validationCases";

export const BATTERY_MAX_AGE_DAYS = 30;
export const BATTERY_RETRY_HOURS = 24;
const CONCURRENCY = 4;

export const batteryKey = () => createHash("sha256").update(`${BATTERY_VERSION}|${editorialConfigKey()}`).digest("hex").slice(0, 16);

export type BatteryState = { status: "ok"; at: Date } | { status: "missing" | "stale" | "failed"; reason: string };

export async function batteryState(now: Date): Promise<BatteryState> {
  const last = await prisma.editorialBattery.findFirst({ where: { configKey: batteryKey() }, orderBy: { createdAt: "desc" } });
  if (!last) return { status: "missing", reason: "falta la batería de defectos para esta configuración" };
  if (!last.passed) return { status: "failed", reason: `la batería de defectos no pasa (${last.detected}/${last.total}, ${last.criticalMissed} críticos sin detectar)` };
  if (now.getTime() - last.createdAt.getTime() > BATTERY_MAX_AGE_DAYS * 86400_000) return { status: "stale", reason: "la batería de defectos ha caducado" };
  return { status: "ok", at: last.createdAt };
}

export async function batteryDue(now: Date): Promise<boolean> {
  const last = await prisma.editorialBattery.findFirst({ where: { configKey: batteryKey() }, orderBy: { createdAt: "desc" } });
  if (!last) return true;
  const age = now.getTime() - last.createdAt.getTime();
  return last.passed ? age > BATTERY_MAX_AGE_DAYS * 86400_000 : age > BATTERY_RETRY_HOURS * 3600_000;
}

/** La batería pasa si detecta todos los críticos y al menos BATTERY_MIN_RATE del total. */
export function batteryPasses(results: { critical: boolean; detected: boolean }[]): { passed: boolean; detected: number; criticalMissed: number } {
  const detected = results.filter((r) => r.detected).length;
  const criticalMissed = results.filter((r) => r.critical && !r.detected).length;
  return { passed: criticalMissed === 0 && detected / results.length >= BATTERY_MIN_RATE, detected, criticalMissed };
}

export async function runBattery(runner: Runner, now: Date, siteBase: string): Promise<string> {
  const url = `${siteBase}/blog/${BATTERY_SLUG}`;
  const base = await scoreVersion({ url, md: BASE_ARTICLE, siteBase, runner }, "base");
  const results: { id: string; kind: string; critical: boolean; detected: boolean; reason: string }[] = [];
  const queue = [...BATTERY_CASES];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const d = await pairedDecision({ url, label: c.id, baseMd: BASE_ARTICLE, headMd: c.head, siteBase, runner, base });
        results.push({ id: c.id, kind: c.kind, critical: c.critical, detected: !d.approve, reason: d.reason });
      }
    }),
  );
  results.sort((a, b) => a.id.localeCompare(b.id));
  const r = batteryPasses(results);
  await prisma.editorialBattery.create({
    data: { configKey: batteryKey(), passed: r.passed, detected: r.detected, total: results.length, criticalMissed: r.criticalMissed, detail: { base: base.score, results } as object, createdAt: now },
  });
  const missed = results.filter((x) => !x.detected).map((x) => x.id);
  return `batería de defectos: ${r.passed ? "pasa" : "no pasa"} (${r.detected}/${results.length}${missed.length ? `; se le escapan: ${missed.join(", ")}` : ""})`;
}
