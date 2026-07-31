import { prisma } from "../db";
import { getEnv } from "../env";
import {
  fetchSearchConsoleRows,
  type SearchConsoleRow,
} from "../google/searchConsoleClient";
import { computeFetchStartDate } from "./computeFetchStartDate";

function isoDateDaysAgo(daysAgo: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function getExistingSnapshotDates(lookbackWindowDays: number): Promise<Set<string>> {
  const rows = await prisma.searchConsoleSnapshot.findMany({
    where: { date: { gte: new Date(isoDateDaysAgo(lookbackWindowDays)) } },
    select: { date: true },
    distinct: ["date"],
  });
  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
}

export async function collectSearchConsole(deps: {
  fetchRows?: (params: {
    siteUrl: string;
    startDate: string;
    endDate: string;
  }) => Promise<SearchConsoleRow[]>;
  daysBack?: number;
  lookbackWindowDays?: number;
  getExistingDates?: (lookbackWindowDays: number) => Promise<Set<string>>;
} = {}): Promise<{ inserted: number }> {
  const fetchRows = deps.fetchRows ?? fetchSearchConsoleRows;
  const daysBack = deps.daysBack ?? 3; // GSC data has ~2-3 days of lag
  const lookbackWindowDays = deps.lookbackWindowDays ?? 30;
  const getExistingDates = deps.getExistingDates ?? getExistingSnapshotDates;
  const today = new Date();

  const existingDates = await getExistingDates(lookbackWindowDays);
  const startDate = computeFetchStartDate({
    existingDates,
    today,
    daysBack,
    lookbackWindowDays,
  });

  const rows = await fetchRows({
    siteUrl: getEnv("GSC_SITE_URL"),
    startDate,
    endDate: isoDateDaysAgo(0, today),
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
