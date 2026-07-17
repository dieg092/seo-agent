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
