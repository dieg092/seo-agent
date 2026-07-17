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

export async function fetchAnalyticsRows(params: {
  propertyId: string;
  startDate: string;
  endDate: string;
}): Promise<AnalyticsRow[]> {
  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
      private_key: getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    },
  });

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
