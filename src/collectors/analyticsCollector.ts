// src/collectors/analyticsCollector.ts
import { prisma } from "../db";
import { getEnv } from "../env";
import { fetchAnalyticsRows, type AnalyticsRow } from "../google/analyticsClient";

function isoDateDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

export async function collectAnalytics(deps: {
  fetchRows?: (params: {
    propertyId: string;
    startDate: string;
    endDate: string;
  }) => Promise<AnalyticsRow[]>;
  daysBack?: number;
} = {}): Promise<{ inserted: number }> {
  const fetchRows = deps.fetchRows ?? fetchAnalyticsRows;
  const daysBack = deps.daysBack ?? 3;

  const rows = await fetchRows({
    propertyId: getEnv("GA4_PROPERTY_ID"),
    startDate: isoDateDaysAgo(daysBack),
    endDate: isoDateDaysAgo(0),
  });

  let inserted = 0;
  for (const row of rows) {
    await prisma.analyticsSnapshot.upsert({
      where: {
        date_page_channel: { date: new Date(row.date), page: row.page, channel: row.channel },
      },
      create: {
        date: new Date(row.date),
        page: row.page,
        channel: row.channel,
        sessions: row.sessions,
        engagedSessions: row.engagedSessions,
        conversions: row.conversions,
      },
      update: {
        sessions: row.sessions,
        engagedSessions: row.engagedSessions,
        conversions: row.conversions,
      },
    });
    inserted += 1;
  }

  return { inserted };
}
