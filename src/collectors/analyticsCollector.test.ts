// src/collectors/analyticsCollector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAnalytics } from "./analyticsCollector";
import { prisma } from "../db";
import type { AnalyticsRow } from "../google/analyticsClient";

test("collectAnalytics inserts fetched rows and returns the count", async () => {
  await prisma.analyticsSnapshot.deleteMany({});

  const fakeRows: AnalyticsRow[] = [
    {
      date: "2026-07-01",
      page: "/blog/categoria/ejemplo",
      channel: "Organic Search",
      sessions: 42,
      engagedSessions: 30,
      conversions: 2,
    },
  ];

  const result = await collectAnalytics({ fetchRows: async () => fakeRows });

  assert.equal(result.inserted, 1);
  const stored = await prisma.analyticsSnapshot.findMany();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].channel, "Organic Search");

  await prisma.analyticsSnapshot.deleteMany({});
});

test("collectAnalytics upserts on (date, page, channel)", async () => {
  await prisma.analyticsSnapshot.deleteMany({});

  const rowV1: AnalyticsRow[] = [
    { date: "2026-07-01", page: "/blog/x", channel: "Organic Search", sessions: 10, engagedSessions: 5, conversions: 0 },
  ];
  const rowV2: AnalyticsRow[] = [{ ...rowV1[0], sessions: 15 }];

  await collectAnalytics({ fetchRows: async () => rowV1 });
  const result = await collectAnalytics({ fetchRows: async () => rowV2 });

  assert.equal(result.inserted, 1);
  const stored = await prisma.analyticsSnapshot.findMany();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].sessions, 15);

  await prisma.analyticsSnapshot.deleteMany({});
});
