// src/editorial/calibration.ts
// Calibración sin notas del fundador (B5). Search Console hace de referencia:
//   - los resultados reales (posición y, si hay, interacción orgánica de GA4) eligen 2
//     artículos buenos, 2 medianos y 2 malos; la primera nota de cada uno es su ancla;
//   - cada mes se vuelven a evaluar: si alguno se aleja más de 1 punto de su ancla, la
//     escala del evaluador se ha movido (notas infladas o hundidas) → deriva;
//   - validez: con al menos 12 artículos puntuados, la correlación de rangos entre nota
//     y resultado no puede ser claramente negativa → invertida.
// El CTR no entra en el resultado: depende sobre todo del título y del tema (la primera
// calibración real, 2026-11-18, puso arriba artículos de tendencias por eso). Seis
// artículos son pocos para exigir orden entre ellos; la validez se mira con todos.
// Una deriva se corrige sola volviendo a anclar con referencias nuevas; la inversión no.
import { expectedCtrForPosition } from "../prioritization/expectedCtr";

export const MIN_IMPRESSIONS = 100;
export const MAX_DRIFT = 1;
export const MIN_VALIDITY_N = 12;
/** Correlación de rangos nota–resultado por debajo de esto: el evaluador va al revés. */
export const MIN_SPEARMAN = -0.3;
export const REFERENCE_SIZE = 6;

export interface PageOutcomeInput {
  slug: string;
  impressions: number;
  clicks: number;
  /** Posición media ponderada por impresiones. */
  position: number;
  sessions?: number;
  engagedSessions?: number;
}

export interface PageOutcome {
  slug: string;
  outcome: number;
  ctrRatio: number;
  position: number;
  engagement: number | null;
}

/** Rango percentil en [0, 1]; los empates comparten el rango medio. */
function percentiles(values: number[]): number[] {
  if (values.length === 1) return [0.5];
  return values.map((v) => {
    const below = values.filter((x) => x < v).length;
    const equal = values.filter((x) => x === v).length;
    return (below + (equal - 1) / 2) / (values.length - 1);
  });
}

/** Resultado de 0 a 10 por artículo, relativo al resto del blog. */
export function computeOutcomes(rows: PageOutcomeInput[]): PageOutcome[] {
  const eligible = rows.filter((r) => r.impressions >= MIN_IMPRESSIONS && r.position > 0);
  if (!eligible.length) return [];
  const ctrRatio = eligible.map((r) => r.clicks / r.impressions / expectedCtrForPosition(r.position));
  const engagement = eligible.map((r) => (r.sessions && r.sessions >= 20 ? (r.engagedSessions ?? 0) / r.sessions : null));
  const pPos = percentiles(eligible.map((r) => -r.position));
  const withEng = engagement.map((e, i) => [e, i] as const).filter(([e]) => e !== null) as [number, number][];
  const pEngMap = new Map<number, number>();
  if (withEng.length >= 3) percentiles(withEng.map(([e]) => e)).forEach((p, j) => pEngMap.set(withEng[j][1], p));
  return eligible.map((r, i) => {
    const parts = [pPos[i], ...(pEngMap.has(i) ? [pEngMap.get(i)!] : [])];
    return {
      slug: r.slug,
      outcome: Math.round((parts.reduce((s, p) => s + p, 0) / parts.length) * 1000) / 100,
      ctrRatio: Math.round(ctrRatio[i] * 100) / 100,
      position: Math.round(r.position * 10) / 10,
      engagement: engagement[i] === null ? null : Math.round(engagement[i]! * 100) / 100,
    };
  });
}

export type Tier = "good" | "mid" | "bad";
export interface Reference {
  slug: string;
  tier: Tier;
  outcome: number;
  contentHash: string | null;
  anchor: number | null;
}

/** 2 mejores, 2 del centro y 2 peores por resultado. Con menos de 6 elegibles, nada. */
export function pickReferences(outcomes: PageOutcome[]): { slug: string; tier: Tier; outcome: number }[] {
  if (outcomes.length < REFERENCE_SIZE) return [];
  const s = [...outcomes].sort((a, b) => b.outcome - a.outcome || a.slug.localeCompare(b.slug));
  const mid = Math.floor(s.length / 2) - 1;
  return [
    ...s.slice(0, 2).map((o) => ({ ...o, tier: "good" as const })),
    ...s.slice(mid, mid + 2).map((o) => ({ ...o, tier: "mid" as const })),
    ...s.slice(-2).map((o) => ({ ...o, tier: "bad" as const })),
  ].map(({ slug, tier, outcome }) => ({ slug, tier, outcome }));
}

export type CalibrationStatus = "ok" | "drift" | "inverted";

export interface CalibrationCheck {
  status: CalibrationStatus;
  detail: string;
  drift: { slug: string; anchor: number; score: number }[];
}

/** Correlación de Spearman con rangos medios para los empates. */
export function spearman(pairs: [number, number][]): number {
  const rank = (v: number[]) => v.map((x) => v.filter((y) => y < x).length + (v.filter((y) => y === x).length - 1) / 2);
  const a = rank(pairs.map((p) => p[0]));
  const b = rank(pairs.map((p) => p[1]));
  const n = pairs.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? Math.round((num / Math.sqrt(da * db)) * 100) / 100 : 0;
}

export function checkCalibration(
  refs: { slug: string; anchor: number | null }[],
  scores: Map<string, number>,
  validity: [number, number][],
): CalibrationCheck {
  const drift = refs
    .filter((r) => r.anchor !== null && scores.has(r.slug) && Math.abs(scores.get(r.slug)! - r.anchor) > MAX_DRIFT)
    .map((r) => ({ slug: r.slug, anchor: r.anchor!, score: scores.get(r.slug)! }));
  const rho = validity.length >= MIN_VALIDITY_N ? spearman(validity) : null;
  const v = rho === null ? `validez pendiente (${validity.length}/${MIN_VALIDITY_N} artículos puntuados)` : `correlación nota–GSC ${rho} con ${validity.length} artículos`;
  if (rho !== null && rho < MIN_SPEARMAN) return { status: "inverted", detail: v, drift };
  if (drift.length) return { status: "drift", detail: `${drift.length} referencia(s) a más de ${MAX_DRIFT} punto de su ancla; ${v}`, drift };
  return { status: "ok", detail: v, drift };
}
