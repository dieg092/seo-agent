// src/collectors/searchConsoleFullCollector.ts
// Rendimiento completo de Search Console (§10.1 de la spec): totales por página de los
// 6 tipos, detalle por consulta de image y video, segmentos de web por dispositivo y
// país, y la calidad de los datos por día, tipo y dataset en GscDataQuality.
//
// El colector antiguo (searchConsoleCollector.ts → SearchConsoleSnapshot) sigue igual:
// este no lo toca y solo lee de su tabla los clics con detalle de consulta.
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import {
  DAILY_ROW_CAP,
  fetchSearchAnalytics,
  type GscDimension,
  type GscGenericRow,
  type GscType,
} from "../google/searchConsoleClient";
import { isPrivateUrl } from "../privacy/sitePrivacy";
import { encryptUrl, hmac12, redactUrl, requirePrivateUrlKey } from "../privacy/redact";
import { isBrandQuery } from "./brand";

export const GSC_TYPES: readonly GscType[] = ["web", "image", "video", "news", "discover", "googleNews"];

type Dataset = "page" | "query" | "segment";

interface DatasetSpec {
  dataset: Dataset;
  type: GscType;
  dimensions: GscDimension[];
}

// Qué se pide. discover y googleNews no admiten "query"; el detalle de web sigue en
// SearchConsoleSnapshot (colector antiguo).
const DATASETS: readonly DatasetSpec[] = [
  ...GSC_TYPES.map((type): DatasetSpec => ({ dataset: "page", type, dimensions: ["date", "page"] })),
  { dataset: "query", type: "image", dimensions: ["date", "page", "query"] },
  { dataset: "query", type: "video", dimensions: ["date", "page", "query"] },
  { dataset: "segment", type: "web", dimensions: ["date", "page", "device", "country"] },
];

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(today: Date, days: number): string {
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return new Date(base - days * DAY_MS).toISOString().slice(0, 10);
}

function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Ventanas a pedir:
 * - provisional: los últimos `provisionalDays` días completos (de hoy-N a ayer), con dataState "all".
 * - finalDates: los días anteriores dentro de `lookbackDays` que no están marcados como
 *   finales (huecos o provisionales antiguos), para pedirlos con "final".
 */
export function planFetchWindows(p: {
  today: Date;
  existing: { date: string; isFinal: boolean }[];
  lookbackDays?: number;
  provisionalDays?: number;
}): { provisional: { start: string; end: string }; finalDates: string[] } {
  const lookbackDays = p.lookbackDays ?? 30;
  const provisionalDays = p.provisionalDays ?? 4;
  const finalByDate = new Map(p.existing.map((e) => [e.date, e.isFinal]));

  const finalDates: string[] = [];
  for (let n = lookbackDays; n > provisionalDays; n--) {
    const date = isoDaysAgo(p.today, n);
    if (finalByDate.get(date) !== true) finalDates.push(date);
  }

  return {
    provisional: { start: isoDaysAgo(p.today, provisionalDays), end: isoDaysAgo(p.today, 1) },
    finalDates,
  };
}

// Agrupa fechas consecutivas en rangos para hacer una sola petición por rango.
function toRanges(dates: string[]): { start: string; end: string }[] {
  const sorted = [...dates].sort();
  const ranges: { start: string; end: string }[] = [];
  for (const date of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && Date.parse(date) - Date.parse(last.end) === DAY_MS) last.end = date;
    else ranges.push({ start: date, end: date });
  }
  return ranges;
}

function isRateLimited(error: unknown): boolean {
  const e = error as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  return String(e?.code) === "429" || e?.status === 429 || e?.response?.status === 429;
}

interface StoredRow {
  date: string;
  page: string;
  query?: string;
  device?: string;
  country?: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

// Tras redactar, dos URLs distintas pueden quedar iguales (http/https, barra final):
// se suman para no romper la clave única. Una fila sola se guarda tal cual.
function mergeRows(a: StoredRow, b: StoredRow): StoredRow {
  const impressions = a.impressions + b.impressions;
  const clicks = a.clicks + b.clicks;
  let position: number | null = null;
  if (a.position !== null || b.position !== null) {
    const wa = a.position !== null ? a.impressions : 0;
    const wb = b.position !== null ? b.impressions : 0;
    position =
      wa + wb > 0
        ? ((a.position ?? 0) * wa + (b.position ?? 0) * wb) / (wa + wb)
        : (a.position ?? b.position);
  }
  return { ...a, clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

async function sumSnapshotClicks(date: string): Promise<number> {
  const agg = await prisma.searchConsoleSnapshot.aggregate({
    _sum: { clicks: true },
    where: { date: new Date(date) },
  });
  return agg._sum.clicks ?? 0;
}

async function replaceDay(spec: DatasetSpec, date: string, rows: StoredRow[], isFinal: boolean): Promise<void> {
  const day = new Date(date);
  const where = { date: day, type: spec.type };
  const base = (r: StoredRow) => ({
    date: day,
    page: r.page,
    type: spec.type,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
    isFinal,
  });

  // Se reemplaza el día entero: así un provisional pasa a final sin duplicarse y
  // desaparecen las filas provisionales que GSC ya no devuelve.
  if (spec.dataset === "page") {
    await prisma.$transaction([
      prisma.searchConsolePageDaily.deleteMany({ where }),
      prisma.searchConsolePageDaily.createMany({ data: rows.map(base) }),
    ]);
  } else if (spec.dataset === "query") {
    await prisma.$transaction([
      prisma.searchConsoleQueryTyped.deleteMany({ where }),
      prisma.searchConsoleQueryTyped.createMany({
        data: rows.map((r) => ({ ...base(r), query: r.query ?? "", isBrand: isBrandQuery(r.query ?? "") })),
      }),
    ]);
  } else {
    await prisma.$transaction([
      prisma.searchConsoleSegmentDaily.deleteMany({ where }),
      prisma.searchConsoleSegmentDaily.createMany({
        data: rows.map((r) => ({ ...base(r), device: r.device ?? "", country: r.country ?? "" })),
      }),
    ]);
  }
}

/**
 * Registro de URLs privadas por defecto: guarda o reabre el PrivateIncident (la URL real,
 * solo cifrada) y apunta las nuevas para avisar una sola vez al final de la ejecución.
 */
function createDefaultPrivateRecorder(key: string, now: Date) {
  const fresh: { hmac: string; source: string }[] = [];
  const record = async (url: string, source: string): Promise<void> => {
    const urlHmac = hmac12(url, key);
    const existing = await prisma.privateIncident.findUnique({ where: { urlHmac } });
    if (!existing) {
      await prisma.privateIncident.create({
        data: { urlHmac, urlEncrypted: encryptUrl(url, key), firstSeenAt: now, lastSeenAt: now, sources: [source] },
      });
      fresh.push({ hmac: urlHmac, source });
      return;
    }
    await prisma.privateIncident.update({
      where: { urlHmac },
      data: {
        lastSeenAt: now,
        sources: existing.sources.includes(source) ? existing.sources : [...existing.sources, source],
        resolvedAt: null,
      },
    });
    if (existing.resolvedAt) fresh.push({ hmac: urlHmac, source });
  };
  return { record, fresh };
}

export async function collectSearchConsoleFull(
  deps: {
    fetch?: typeof fetchSearchAnalytics;
    today?: Date;
    alert?: typeof recordAlert;
    recordPrivate?: (url: string, source: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<{ pageDaily: number; queryRows: number; segmentRows: number; privateSeen: number; capped: number; failed: number }> {
  // Sin clave no se escribe nada: nunca se guarda una URL privada en claro.
  const key = requirePrivateUrlKey();
  const fetch = deps.fetch ?? fetchSearchAnalytics;
  const today = deps.today ?? new Date();
  const alert = deps.alert ?? recordAlert;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const defaultRecorder = deps.recordPrivate ? null : createDefaultPrivateRecorder(key, new Date());
  const recordPrivate = deps.recordPrivate ?? defaultRecorder!.record;

  const lookbackDays = 30;
  const existing = await prisma.gscDataQuality.findMany({
    where: { dataset: "page", type: "web", date: { gte: new Date(isoDaysAgo(today, lookbackDays)) } },
    select: { date: true, isFinal: true },
  });
  const windows = planFetchWindows({
    today,
    lookbackDays,
    existing: existing.map((e) => ({ date: e.date.toISOString().slice(0, 10), isFinal: e.isFinal })),
  });

  const requests: { start: string; end: string; dataState: "final" | "all" }[] = [
    ...toRanges(windows.finalDates).map((r) => ({ ...r, dataState: "final" as const })),
    { ...windows.provisional, dataState: "all" },
  ];

  const result = { pageDaily: 0, queryRows: 0, segmentRows: 0, privateSeen: 0, capped: 0, failed: 0 };
  const recordedPrivate = new Set<string>();
  const seenPrivate = new Set<string>();
  const cappedDays: string[] = [];
  const failures: string[] = [];

  const fetchWithRetry = async (params: Parameters<typeof fetchSearchAnalytics>[0]) => {
    // Con un 429 se espera de forma exponencial hasta 3 veces.
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(params);
      } catch (error) {
        if (!isRateLimited(error) || attempt >= 3) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  };

  for (const spec of DATASETS) {
    for (const req of requests) {
      let fetched: { rows: GscGenericRow[]; rowsByDate: Map<string, number> };
      try {
        fetched = await fetchWithRetry({
          startDate: req.start,
          endDate: req.end,
          type: spec.type,
          dimensions: spec.dimensions,
          dataState: req.dataState,
        });
      } catch (error) {
        // Un dataset que falla no corta los demás.
        result.failed += 1;
        failures.push(`${spec.dataset}:${spec.type} ${req.start}..${req.end}: ${(error as Error)?.message ?? error}`);
        continue;
      }

      // Agrupa por día y clave, redactando las URLs privadas.
      const byDate = new Map<string, Map<string, StoredRow>>();
      for (const row of fetched.rows) {
        const date = row.keys.date;
        const rawPage = row.keys.page;
        if (!date || !rawPage) continue;

        if (isPrivateUrl(rawPage)) {
          seenPrivate.add(rawPage);
          const source = `gsc:${spec.type}`;
          const recKey = `${source} ${rawPage}`;
          if (!recordedPrivate.has(recKey)) {
            recordedPrivate.add(recKey);
            await recordPrivate(rawPage, source);
          }
        }
        const page = redactUrl(rawPage, key);
        const stored: StoredRow = {
          date,
          page,
          query: row.keys.query,
          device: row.keys.device,
          country: row.keys.country,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        };
        const rowKey = [page, stored.query, stored.device, stored.country].join("\u0000");
        const day = byDate.get(date) ?? new Map<string, StoredRow>();
        const prev = day.get(rowKey);
        day.set(rowKey, prev ? mergeRows(prev, stored) : stored);
        byDate.set(date, day);
      }

      const isFinalRequest = req.dataState === "final";
      for (const date of datesBetween(req.start, req.end)) {
        const rowsReturned = fetched.rowsByDate.get(date) ?? 0;
        const rows = [...(byDate.get(date)?.values() ?? [])];
        const capped = rowsReturned >= DAILY_ROW_CAP;
        if (capped) {
          result.capped += 1;
          cappedDays.push(`${date} ${spec.dataset}:${spec.type} (${rowsReturned} filas)`);
        }

        if (rows.length > 0) {
          await replaceDay(spec, date, rows, isFinalRequest);
          if (spec.dataset === "page") result.pageDaily += rows.length;
          else if (spec.dataset === "query") result.queryRows += rows.length;
          else result.segmentRows += rows.length;
        }

        // Un día final de page:web sin filas suele ser que GSC aún no lo tiene: se deja
        // como no final para volver a pedirlo. En los demás tipos, 0 filas es normal.
        const isPageWeb = spec.dataset === "page" && spec.type === "web";
        const isFinal = isFinalRequest && !(isPageWeb && rowsReturned === 0);

        let pageTotalClicks: number | null = null;
        let queryDetailClicks: number | null = null;
        let anonymizedShare: number | null = null;
        if (isPageWeb) {
          pageTotalClicks = fetched.rows.reduce((s, r) => (r.keys.date === date ? s + r.clicks : s), 0);
          queryDetailClicks = await sumSnapshotClicks(date);
          anonymizedShare = pageTotalClicks > 0 ? 1 - queryDetailClicks / pageTotalClicks : null;
        }

        const quality = {
          rowsReturned,
          capped,
          pageTotalClicks,
          queryDetailClicks,
          anonymizedShare,
          isFinal,
          fetchedAt: new Date(),
        };
        await prisma.gscDataQuality.upsert({
          where: { date_type_dataset: { date: new Date(date), type: spec.type, dataset: spec.dataset } },
          create: { date: new Date(date), type: spec.type, dataset: spec.dataset, ...quality },
          update: quality,
        });
      }
    }
  }

  result.privateSeen = seenPrivate.size;

  if (cappedDays.length > 0) {
    await alert({
      type: "gsc-row-cap",
      subject: "Search Console: días con el tope de filas",
      body: `GSC ha devuelto ${DAILY_ROW_CAP} filas o más (datos truncados) en:\n${cappedDays.join("\n")}`,
    });
  }

  if (defaultRecorder && defaultRecorder.fresh.length > 0) {
    // Nunca la URL real: solo el hmac y el origen.
    const list = defaultRecorder.fresh.slice(0, 20).map((f) => `<privada:${f.hmac}> (${f.source})`);
    const more = defaultRecorder.fresh.length > 20 ? `\n… y ${defaultRecorder.fresh.length - 20} más` : "";
    await alert({
      type: "private-url-exposed",
      subject: `Search Console muestra ${defaultRecorder.fresh.length} URL(s) privada(s)`,
      body: `Páginas privadas con datos en GSC (guardadas redactadas, la URL real está cifrada en PrivateIncident):\n${list.join("\n")}${more}`,
    });
  }

  if (failures.length > 0) {
    await alert({
      type: "gsc-full-fetch-error",
      subject: `Search Console completo: ${failures.length} petición(es) fallida(s)`,
      body: failures.join("\n"),
    });
  }

  return result;
}
