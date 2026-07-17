import { prisma } from "../db";
import { getEnv } from "../env";
import {
  fetchSearchConsoleRows,
  type SearchConsoleRow,
} from "../google/searchConsoleClient";

function isoDateDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function collectSearchConsole(deps: {
  fetchRows?: (params: {
    siteUrl: string;
    startDate: string;
    endDate: string;
  }) => Promise<SearchConsoleRow[]>;
  daysBack?: number;
} = {}): Promise<{ inserted: number }> {
  const fetchRows = deps.fetchRows ?? fetchSearchConsoleRows;
  const daysBack = deps.daysBack ?? 3; // GSC data has ~2-3 days of lag

  const rows = await fetchRows({
    siteUrl: getEnv("GSC_SITE_URL"),
    startDate: isoDateDaysAgo(daysBack),
    endDate: isoDateDaysAgo(0),
  });

  let inserted = 0;
  for (const row of rows) {
    await prisma.searchConsoleSnapshot.upsert({
      where: {
        date_page_query: { date: new Date(row.date), page: row.page, query: row.query },
      },
      create: {
        date: new Date(row.date),
        page: row.page,
        query: row.query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      },
      update: {
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      },
    });
    inserted += 1;
  }

  return { inserted };
}
