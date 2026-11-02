// src/collectors/analyticsLandingCollector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAnalyticsLanding, landingForStorage } from "./analyticsLandingCollector";
import { fetchLandingRows, type LandingReportFn, type LandingRow } from "../google/analyticsClient";
import { prisma } from "../db";

const KEY = "clave-de-prueba-landing";
process.env.SEO_PRIVATE_URL_KEY = KEY;

// Los tests solo escriben en fechas del año 2000, que no existen en datos reales,
// y solo borran esas filas.
const FROM = new Date("2000-01-01");
const TO = new Date("2000-01-31");

async function cleanup() {
  await prisma.analyticsLandingDaily.deleteMany({ where: { date: { gte: FROM, lte: TO } } });
}

async function storedRows() {
  return prisma.analyticsLandingDaily.findMany({
    where: { date: { gte: FROM, lte: TO } },
    orderBy: [{ landingPage: "asc" }, { channel: "asc" }],
  });
}

function fakeFetch(rows: LandingRow[]): typeof fetchLandingRows {
  return async () => ({ rows, metric: "keyEvents" });
}

test("guarda keyEvents por landing y canal", async () => {
  await cleanup();
  try {
    const rows: LandingRow[] = [
      { date: "2000-01-05", landingPage: "/blog/test-landing", channel: "Organic Search", sessions: 40, engagedSessions: 25, keyEvents: 3 },
      { date: "2000-01-05", landingPage: "/blog/test-landing", channel: "Direct", sessions: 10, engagedSessions: 4, keyEvents: 0.5 },
      // Misma landing con barra final: se suma a la primera tras normalizar.
      { date: "2000-01-05", landingPage: "/blog/test-landing/", channel: "Organic Search", sessions: 2, engagedSessions: 1, keyEvents: 1 },
      { date: "2000-01-05", landingPage: "(not set)", channel: "Direct", sessions: 1, engagedSessions: 0, keyEvents: 0 },
    ];

    const result = await collectAnalyticsLanding({ fetch: fakeFetch(rows) });
    assert.equal(result.saved, 3);
    assert.equal(result.privateLandings, 0);

    const stored = await storedRows();
    assert.equal(stored.length, 3);
    const [notSet, direct, organic] = stored;
    assert.equal(notSet.landingPage, "(not set)");
    assert.equal(direct.landingPage, "https://miwebdeboda.com/blog/test-landing");
    assert.equal(direct.channel, "Direct");
    assert.equal(direct.keyEvents, 0.5);
    assert.equal(organic.channel, "Organic Search");
    assert.equal(organic.sessions, 42);
    assert.equal(organic.engagedSessions, 26);
    assert.equal(organic.keyEvents, 4);

    // Una segunda pasada actualiza sin duplicar.
    await collectAnalyticsLanding({
      fetch: fakeFetch([{ ...rows[1], sessions: 11, keyEvents: 2 }]),
    });
    const after = await storedRows();
    assert.equal(after.length, 3);
    const directAfter = after.find((r) => r.channel === "Direct" && r.landingPage !== "(not set)");
    assert.equal(directAfter?.sessions, 11);
    assert.equal(directAfter?.keyEvents, 2);
  } finally {
    await cleanup();
  }
});

test("redacta landing privada", async () => {
  await cleanup();
  try {
    const rows: LandingRow[] = [
      { date: "2000-01-06", landingPage: "/ana-y-luis-test", channel: "Direct", sessions: 5, engagedSessions: 3, keyEvents: 1 },
      { date: "2000-01-06", landingPage: "/ana-y-luis-test/i/tok123", channel: "Referral", sessions: 2, engagedSessions: 2, keyEvents: 0 },
      { date: "2000-01-06", landingPage: "/admin/cuenta", channel: "Direct", sessions: 1, engagedSessions: 1, keyEvents: 0 },
    ];

    const result = await collectAnalyticsLanding({ fetch: fakeFetch(rows) });
    assert.equal(result.saved, 3);
    assert.equal(result.privateLandings, 3);

    const stored = await storedRows();
    assert.equal(stored.length, 3);
    for (const r of stored) {
      assert.match(r.landingPage, /^https:\/\/miwebdeboda\.com\/<privada:[0-9a-f]{12}>$/);
      assert.ok(!r.landingPage.includes("ana-y-luis"));
      assert.ok(!r.landingPage.includes("tok123"));
      assert.ok(!r.landingPage.includes("admin"));
    }
    // El hash es estable: la misma ruta con barra final da la misma landing redactada.
    assert.equal(landingForStorage("/ana-y-luis-test/", KEY), landingForStorage("/ana-y-luis-test", KEY));
  } finally {
    await cleanup();
  }
});

test("sin SEO_PRIVATE_URL_KEY falla antes de pedir ni escribir nada", async () => {
  const saved = process.env.SEO_PRIVATE_URL_KEY;
  delete process.env.SEO_PRIVATE_URL_KEY;
  let called = false;
  try {
    await assert.rejects(
      collectAnalyticsLanding({
        fetch: async () => {
          called = true;
          return { rows: [], metric: "keyEvents" };
        },
      }),
      /SEO_PRIVATE_URL_KEY/
    );
    assert.equal(called, false);
  } finally {
    process.env.SEO_PRIVATE_URL_KEY = saved;
  }
});

test("cae a conversions si keyEvents falla", async () => {
  const requested: string[][] = [];
  const warnings: string[] = [];
  const runReport: LandingReportFn = async (req) => {
    requested.push(req.metrics);
    assert.deepEqual(req.dimensions, ["date", "landingPage", "sessionDefaultChannelGroup"]);
    if (req.metrics.includes("keyEvents")) {
      throw Object.assign(new Error("3 INVALID_ARGUMENT: Field keyEvents is not a valid metric."), { code: 3 });
    }
    return {
      rows: [
        {
          dimensionValues: [{ value: "20000107" }, { value: "/blog/test-landing" }, { value: "Organic Search" }],
          metricValues: [{ value: "8" }, { value: "6" }, { value: "2" }],
        },
      ],
    };
  };

  const result = await fetchLandingRows(
    { propertyId: "000000000", startDate: "2000-01-07", endDate: "2000-01-07" },
    { runReport, warn: (m) => warnings.push(m) }
  );

  assert.deepEqual(requested, [
    ["sessions", "engagedSessions", "keyEvents"],
    ["sessions", "engagedSessions", "conversions"],
  ]);
  assert.equal(result.metric, "conversions");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /conversions/);
  assert.deepEqual(result.rows, [
    { date: "2000-01-07", landingPage: "/blog/test-landing", channel: "Organic Search", sessions: 8, engagedSessions: 6, keyEvents: 2 },
  ]);
});

test("un error que no es de keyEvents no se reintenta", async () => {
  let calls = 0;
  const runReport: LandingReportFn = async () => {
    calls += 1;
    throw Object.assign(new Error("7 PERMISSION_DENIED: sin acceso"), { code: 7 });
  };
  await assert.rejects(
    fetchLandingRows({ propertyId: "0", startDate: "2000-01-07", endDate: "2000-01-07" }, { runReport, warn: () => {} }),
    /PERMISSION_DENIED/
  );
  assert.equal(calls, 1);
});
