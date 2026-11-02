import { google } from "googleapis";
import { getEnv } from "../env";

export interface SearchConsoleRow {
  date: string;
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

// --- Cliente genérico de Search Analytics (fase 1) ---
// Lo usan los colectores nuevos; fetchSearchConsoleRows (abajo) se mantiene tal cual
// para el colector existente.

export type GscType = "web" | "image" | "video" | "news" | "discover" | "googleNews";
export type GscDimension = "date" | "page" | "query" | "device" | "country";

export interface GscGenericRow {
  keys: Partial<Record<GscDimension, string>>;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export type GscQueryFn = (body: {
  startDate: string;
  endDate: string;
  type: GscType;
  dimensions: GscDimension[];
  dataState: "final" | "all";
  rowLimit: number;
  startRow: number;
}) => Promise<{
  rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[];
}>;

// Máximo de filas por petición que admite la API.
export const GSC_ROW_LIMIT = 25_000;
// Filas por día a partir de las cuales consideramos que GSC ha truncado los datos.
export const DAILY_ROW_CAP = 50_000;

// Tipos de búsqueda que no admiten la dimensión query.
const TYPES_WITHOUT_QUERY: readonly GscType[] = ["discover", "googleNews"];

function defaultQueryFn(): GscQueryFn {
  const auth = new google.auth.JWT(
    getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    undefined,
    getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/webmasters.readonly"]
  );
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const siteUrl = getEnv("GSC_SITE_URL");
  return async (body) => {
    const response = await searchconsole.searchanalytics.query({ siteUrl, requestBody: body });
    return {
      rows: (response.data.rows ?? []).map((r) => ({
        keys: r.keys ?? undefined,
        clicks: r.clicks ?? undefined,
        impressions: r.impressions ?? undefined,
        ctr: r.ctr ?? undefined,
        position: r.position ?? undefined,
      })),
    };
  };
}

export async function fetchSearchAnalytics(
  p: {
    startDate: string;
    endDate: string;
    type: GscType;
    dimensions: GscDimension[];
    dataState?: "final" | "all";
  },
  deps: { query?: GscQueryFn } = {}
): Promise<{ rows: GscGenericRow[]; rowsByDate: Map<string, number> }> {
  if (p.dimensions.includes("query") && TYPES_WITHOUT_QUERY.includes(p.type)) {
    throw new Error(`Search Console no admite la dimensión "query" con type "${p.type}"`);
  }

  const query = deps.query ?? defaultQueryFn();
  const rows: GscGenericRow[] = [];
  const rowsByDate = new Map<string, number>();
  let startRow = 0;

  while (true) {
    const response = await query({
      startDate: p.startDate,
      endDate: p.endDate,
      type: p.type,
      dimensions: p.dimensions,
      dataState: p.dataState ?? "final",
      rowLimit: GSC_ROW_LIMIT,
      startRow,
    });

    const batch = response.rows ?? [];
    for (const row of batch) {
      const keys: Partial<Record<GscDimension, string>> = {};
      p.dimensions.forEach((dim, i) => {
        const value = row.keys?.[i];
        if (value !== undefined) keys[dim] = value;
      });
      rows.push({
        keys,
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: typeof row.position === "number" ? row.position : null,
      });
      if (keys.date !== undefined) {
        rowsByDate.set(keys.date, (rowsByDate.get(keys.date) ?? 0) + 1);
      }
    }

    if (batch.length < GSC_ROW_LIMIT) break;
    startRow += GSC_ROW_LIMIT;
  }

  return { rows, rowsByDate };
}

export async function fetchSearchConsoleRows(params: {
  siteUrl: string;
  startDate: string;
  endDate: string;
}): Promise<SearchConsoleRow[]> {
  const auth = new google.auth.JWT(
    getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    undefined,
    getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/webmasters.readonly"]
  );
  const searchconsole = google.searchconsole({ version: "v1", auth });

  const rows: SearchConsoleRow[] = [];
  let startRow = 0;
  const rowLimit = 25000;

  while (true) {
    const response = await searchconsole.searchanalytics.query({
      siteUrl: params.siteUrl,
      requestBody: {
        startDate: params.startDate,
        endDate: params.endDate,
        dimensions: ["date", "page", "query"],
        rowLimit,
        startRow,
      },
    });

    const batch = response.data.rows ?? [];
    for (const row of batch) {
      const [date, page, query] = row.keys ?? [];
      rows.push({
        date: date ?? "",
        page: page ?? "",
        query: query ?? "",
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
      });
    }

    if (batch.length < rowLimit) break;
    startRow += rowLimit;
  }

  return rows;
}
