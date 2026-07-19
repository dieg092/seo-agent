import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSearchConsole } from "./searchConsoleCollector";
import { prisma } from "../db";
import type { SearchConsoleRow } from "../google/searchConsoleClient";

// The live database holds real Google Search Console history in SearchConsoleSnapshot
// (Fase 1 daily collector). Once wiped, historical daily snapshots older than what the
// GSC API will serve going forward are permanently lost — never delete unscoped without
// backing up and restoring first.
async function withEmptySearchConsoleSnapshots<T>(fn: () => Promise<T>): Promise<T> {
  const backup = await prisma.searchConsoleSnapshot.findMany({});
  await prisma.searchConsoleSnapshot.deleteMany({});
  try {
    return await fn();
  } finally {
    await prisma.searchConsoleSnapshot.deleteMany({});
    if (backup.length > 0) {
      await prisma.searchConsoleSnapshot.createMany({ data: backup });
    }
  }
}

test("collectSearchConsole inserts fetched rows and returns the count", async () => {
  await withEmptySearchConsoleSnapshots(async () => {
    const fakeRows: SearchConsoleRow[] = [
      {
        date: "2026-07-01",
        page: "https://miwebdeboda.com/blog/categoria/ejemplo",
        query: "invitaciones de boda digitales",
        clicks: 12,
        impressions: 340,
        ctr: 0.035,
        position: 8.2,
      },
    ];

    const result = await collectSearchConsole({
      fetchRows: async () => fakeRows,
    });

    assert.equal(result.inserted, 1);

    const stored = await prisma.searchConsoleSnapshot.findMany();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].query, "invitaciones de boda digitales");
  });
});

test("collectSearchConsole upserts on (date, page, query) instead of duplicating", async () => {
  await withEmptySearchConsoleSnapshots(async () => {
    const rowV1: SearchConsoleRow[] = [
      {
        date: "2026-07-01",
        page: "https://miwebdeboda.com/blog/categoria/ejemplo",
        query: "invitaciones de boda digitales",
        clicks: 5,
        impressions: 100,
        ctr: 0.05,
        position: 10,
      },
    ];
    const rowV2: SearchConsoleRow[] = [{ ...rowV1[0], clicks: 9 }];

    await collectSearchConsole({ fetchRows: async () => rowV1 });
    const result = await collectSearchConsole({ fetchRows: async () => rowV2 });

    assert.equal(result.inserted, 1);
    const stored = await prisma.searchConsoleSnapshot.findMany();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].clicks, 9);
  });
});
