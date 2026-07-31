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

test("collectSearchConsole pide un rango más amplio cuando detecta huecos en la BD (backfill)", async () => {
  await withEmptySearchConsoleSnapshots(async () => {
    // today fijo: evita que el test sea inestable si la ejecución cruza
    // la medianoche UTC entre construir la fixture y hacer la aserción.
    const today = new Date("2026-07-31T12:00:00.000Z");

    // Rellena todos los días de la ventana de 30 días excepto uno solo,
    // "hace 10 días" — simula que el cron falló ese día concreto (p. ej.
    // por el watchdog en fallo, T05) y el resto de días sí tiene datos.
    const rowsToInsert = [];
    for (let i = 3; i <= 30; i++) {
      if (i === 10) continue; // el hueco a detectar
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      rowsToInsert.push({
        date: d,
        page: "https://miwebdeboda.com/blog/categoria/otro",
        query: `consulta-${i}`,
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 5,
      });
    }
    await prisma.searchConsoleSnapshot.createMany({ data: rowsToInsert });

    let requestedStartDate = "";
    await collectSearchConsole({
      today,
      fetchRows: async (params) => {
        requestedStartDate = params.startDate;
        return [];
      },
    });

    const tenDaysAgo = new Date(today);
    tenDaysAgo.setUTCDate(tenDaysAgo.getUTCDate() - 10);
    assert.equal(requestedStartDate, tenDaysAgo.toISOString().slice(0, 10));
  });
});

test("collectSearchConsole usa la ventana normal de 3 días cuando no hay huecos", async () => {
  await withEmptySearchConsoleSnapshots(async () => {
    const today = new Date("2026-07-31T12:00:00.000Z");

    const rowsToInsert = [];
    for (let i = 3; i <= 30; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      rowsToInsert.push({
        date: d,
        page: "https://miwebdeboda.com/blog/categoria/otro",
        query: `consulta-${i}`,
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 5,
      });
    }
    await prisma.searchConsoleSnapshot.createMany({ data: rowsToInsert });

    let requestedStartDate = "";
    await collectSearchConsole({
      today,
      fetchRows: async (params) => {
        requestedStartDate = params.startDate;
        return [];
      },
    });

    const threeDaysAgo = new Date(today);
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    assert.equal(requestedStartDate, threeDaysAgo.toISOString().slice(0, 10));
  });
});
