// src/google/analyticsClient.ts
import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { getEnv } from "../env";

export interface AnalyticsRow {
  date: string;
  page: string;
  channel: string;
  sessions: number;
  engagedSessions: number;
  conversions: number;
}

function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function createClient(): BetaAnalyticsDataClient {
  return new BetaAnalyticsDataClient({
    credentials: {
      client_email: getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
      private_key: getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    },
  });
}

export async function fetchAnalyticsRows(params: {
  propertyId: string;
  startDate: string;
  endDate: string;
}): Promise<AnalyticsRow[]> {
  const client = createClient();

  const [response] = await client.runReport({
    property: `properties/${params.propertyId}`,
    dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
    dimensions: [{ name: "date" }, { name: "pagePath" }, { name: "sessionDefaultChannelGroup" }],
    metrics: [
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "conversions" },
    ],
  });

  const rows: AnalyticsRow[] = [];
  for (const row of response.rows ?? []) {
    const [date, page, channel] = row.dimensionValues ?? [];
    const [sessions, engagedSessions, conversions] = row.metricValues ?? [];
    rows.push({
      date: toIsoDate(date?.value ?? ""),
      page: page?.value ?? "",
      channel: channel?.value ?? "",
      sessions: Number(sessions?.value ?? 0),
      engagedSessions: Number(engagedSessions?.value ?? 0),
      conversions: Number(conversions?.value ?? 0),
    });
  }

  return rows;
}

// --- Por página de entrada (fase 1, Task 7) ---

export interface LandingRow {
  date: string;
  /** Ruta tal como la da GA4 (`/blog/x`, `(not set)`…). Sin redactar: lo hace el colector. */
  landingPage: string;
  channel: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
}

export type LandingMetric = "keyEvents" | "conversions";

/** Forma mínima de la respuesta de runReport que usamos. */
export interface LandingReportResponse {
  rows?:
    | {
        dimensionValues?: { value?: string | null }[] | null;
        metricValues?: { value?: string | null }[] | null;
      }[]
    | null;
}

export type LandingReportFn = (request: {
  propertyId: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
}) => Promise<LandingReportResponse>;

const LANDING_DIMENSIONS = ["date", "landingPage", "sessionDefaultChannelGroup"];

const defaultLandingReport: LandingReportFn = async (req) => {
  const client = createClient();
  const [response] = await client.runReport({
    property: `properties/${req.propertyId}`,
    dateRanges: [{ startDate: req.startDate, endDate: req.endDate }],
    dimensions: req.dimensions.map((name) => ({ name })),
    metrics: req.metrics.map((name) => ({ name })),
    // Por defecto la API corta en 10.000 filas; unos días por landing y canal caben de sobra.
    limit: 100_000,
  });
  return response as LandingReportResponse;
};

// Error de la API que indica que no acepta la métrica keyEvents
// (INVALID_ARGUMENT o mención expresa de la métrica).
function isKeyEventsRejected(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : String(error);
  return e?.code === 3 || /keyEvents|INVALID_ARGUMENT/i.test(message);
}

function toLandingRows(response: LandingReportResponse): LandingRow[] {
  const rows: LandingRow[] = [];
  for (const row of response.rows ?? []) {
    const [date, landingPage, channel] = row.dimensionValues ?? [];
    const [sessions, engagedSessions, keyEvents] = row.metricValues ?? [];
    rows.push({
      date: toIsoDate(date?.value ?? ""),
      landingPage: landingPage?.value ?? "",
      channel: channel?.value ?? "",
      sessions: Number(sessions?.value ?? 0),
      engagedSessions: Number(engagedSessions?.value ?? 0),
      keyEvents: Number(keyEvents?.value ?? 0),
    });
  }
  return rows;
}

/**
 * Sesiones, sesiones con interacción y eventos clave por día, página de entrada y canal.
 * Si la API rechaza `keyEvents`, se reintenta con `conversions` (su nombre antiguo)
 * y se avisa en el log; el valor se guarda igualmente como keyEvents.
 */
export async function fetchLandingRows(
  params: { propertyId: string; startDate: string; endDate: string },
  deps: { runReport?: LandingReportFn; warn?: (message: string) => void } = {}
): Promise<{ rows: LandingRow[]; metric: LandingMetric }> {
  const runReport = deps.runReport ?? defaultLandingReport;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const request = (metric: LandingMetric) => ({
    ...params,
    dimensions: LANDING_DIMENSIONS,
    metrics: ["sessions", "engagedSessions", metric],
  });

  try {
    return { rows: toLandingRows(await runReport(request("keyEvents"))), metric: "keyEvents" };
  } catch (error) {
    if (!isKeyEventsRejected(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    warn(`GA4: la API rechazó keyEvents (${reason}); se reintenta con conversions.`);
    return { rows: toLandingRows(await runReport(request("conversions"))), metric: "conversions" };
  }
}
