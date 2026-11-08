// src/collectors/funnelOrganicCollector.test.ts
// La BD de la app se simula en el Postgres local de tests: un esquema propio con
// una vista seo_funnel_daily con las mismas columnas y tipos que la real
// (wedding-invite-2, migración 20261103120000_seo_funnel_daily). Nunca la BD real.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  appFunnelFetcher,
  collectFunnelOrganic,
  funnelWindow,
  madridDate,
  withAppFunnelReader,
  UNKNOWN_LANDING,
} from "./funnelOrganicCollector";
import { prisma } from "../db";

const APP_SCHEMA = "seo_funnel_app_test";
const SLOW_SCHEMA = "seo_funnel_slow_test";

function appUrl(schema: string): string {
  const url = new URL(process.env.APP_FUNNEL_DATABASE_URL ?? "");
  url.searchParams.set("schema", schema);
  return url.toString();
}

// Los tests solo escriben fechas de finales de 1999 y principios de 2000, que no
// existen en datos reales, y solo borran esas filas.
const FROM = new Date("1999-12-01");
const TO = new Date("2000-02-29");
// 31-01-2000 a mediodía: la ventana de 35 días va del 28-12-1999 al 31-01-2000.
const NOW = new Date("2000-01-31T12:00:00Z");

async function cleanup() {
  await prisma.funnelOrganicDaily.deleteMany({ where: { date: { gte: FROM, lte: TO } } });
}

async function storedRows() {
  return prisma.funnelOrganicDaily.findMany({
    where: { date: { gte: FROM, lte: TO } },
    orderBy: [{ date: "asc" }, { landingPath: "asc" }, { channel: "asc" }],
  });
}

type SrcRow = [string, string | null, string, number, number, number, number, number];

async function setSource(rows: SrcRow[]) {
  await prisma.$executeRawUnsafe(`TRUNCATE ${APP_SCHEMA}.funnel_src`);
  for (const r of rows) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${APP_SCHEMA}.funnel_src VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8)`,
      ...r
    );
  }
}

before(async () => {
  for (const schema of [APP_SCHEMA, SLOW_SCHEMA]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA ${schema}`);
  }
  await prisma.$executeRawUnsafe(`
    CREATE TABLE ${APP_SCHEMA}.funnel_src (
      day date, landing_path text, channel text, registros int, bodas_publicadas int,
      primeras_confirmaciones int, pagos int, revenue_cents bigint
    )`);
  await prisma.$executeRawUnsafe(`CREATE VIEW ${APP_SCHEMA}.seo_funnel_daily AS SELECT * FROM ${APP_SCHEMA}.funnel_src`);
  // Vista lenta para comprobar el statement_timeout.
  await prisma.$executeRawUnsafe(`
    CREATE VIEW ${SLOW_SCHEMA}.seo_funnel_daily AS
    SELECT '2000-01-10'::date AS day, NULL::text AS landing_path, 'directo'::text AS channel,
           1 AS registros, 0 AS bodas_publicadas, 0 AS primeras_confirmaciones, 0 AS pagos,
           0::bigint AS revenue_cents
      FROM pg_sleep(3)`);
});

after(async () => {
  await cleanup();
  for (const schema of [APP_SCHEMA, SLOW_SCHEMA]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
});

test("madridDate y funnelWindow usan el día de Madrid", () => {
  // 23:30 UTC del 31-01 ya es 1-02 en Madrid (CET, +1).
  assert.equal(madridDate(new Date("2000-01-31T23:30:00Z")), "2000-02-01");
  // 22:30 UTC del 30-06 ya es 1-07 en Madrid (CEST, +2).
  assert.equal(madridDate(new Date("2000-06-30T22:30:00Z")), "2000-07-01");
  assert.deepEqual(funnelWindow(NOW), { from: "1999-12-28", to: "2000-01-31" });
  assert.deepEqual(funnelWindow(NOW, 1), { from: "2000-01-31", to: "2000-01-31" });
});

test("lee la vista y guarda los últimos 35 días; landing NULL como 'unknown'", async () => {
  await cleanup();
  try {
    await setSource([
      ["2000-01-10", "/blog/organizar-boda", "google", 3, 1, 0, 1, 4900],
      ["2000-01-10", null, "sin datos", 2, 0, 0, 0, 0],
      ["2000-01-11", "/[web-de-pareja]", "directo", 0, 0, 2, 0, 0],
      ["1999-12-28", "/precios", "google", 1, 0, 0, 0, 0],
      // Fuera de la ventana: ni se pide ni se guarda.
      ["1999-12-27", "/precios", "google", 9, 9, 9, 9, 9],
    ]);

    const fetch = appFunnelFetcher(appUrl(APP_SCHEMA));
    const result = await collectFunnelOrganic({ fetch, now: NOW });
    assert.deepEqual(result, { from: "1999-12-28", to: "2000-01-31", saved: 4, removed: 0, unknownLanding: 1 });

    const stored = await storedRows();
    assert.deepEqual(
      stored.map((r) => [
        r.date.toISOString().slice(0, 10),
        r.landingPath,
        r.channel,
        r.registros,
        r.bodasPublicadas,
        r.primerasConfirmaciones,
        r.pagos,
        r.revenueCents,
      ]),
      [
        ["1999-12-28", "/precios", "google", 1, 0, 0, 0, 0],
        ["2000-01-10", "/blog/organizar-boda", "google", 3, 1, 0, 1, 4900],
        ["2000-01-10", UNKNOWN_LANDING, "sin datos", 2, 0, 0, 0, 0],
        ["2000-01-11", "/[web-de-pareja]", "directo", 0, 0, 2, 0, 0],
      ]
    );

    // Segunda pasada: actualiza sin duplicar y quita lo que la vista ya no da
    // (un pago reembolsado deja de salir).
    await setSource([
      ["2000-01-10", "/blog/organizar-boda", "google", 3, 1, 1, 0, 0],
      ["2000-01-10", null, "sin datos", 2, 0, 0, 0, 0],
      ["1999-12-28", "/precios", "google", 1, 0, 0, 0, 0],
    ]);
    const second = await collectFunnelOrganic({ fetch, now: NOW });
    assert.equal(second.saved, 3);
    assert.equal(second.removed, 1);
    const afterRows = await storedRows();
    assert.equal(afterRows.length, 3);
    const blog = afterRows.find((r) => r.landingPath === "/blog/organizar-boda");
    assert.equal(blog?.primerasConfirmaciones, 1);
    assert.equal(blog?.pagos, 0);
    assert.equal(blog?.revenueCents, 0);
    assert.ok(!afterRows.some((r) => r.landingPath === "/[web-de-pareja]"));
  } finally {
    await cleanup();
  }
});

test("una vista vacía no borra lo ya guardado", async () => {
  await cleanup();
  try {
    await setSource([["2000-01-15", "/plantillas", "pinterest", 1, 0, 0, 0, 0]]);
    const fetch = appFunnelFetcher(appUrl(APP_SCHEMA));
    await collectFunnelOrganic({ fetch, now: NOW });
    await setSource([]);
    const result = await collectFunnelOrganic({ fetch, now: NOW });
    assert.equal(result.saved, 0);
    assert.equal(result.removed, 0);
    assert.equal((await storedRows()).length, 1);
  } finally {
    await cleanup();
  }
});

test("la conexión a la app es de solo lectura", async () => {
  await assert.rejects(
    withAppFunnelReader(appUrl(APP_SCHEMA), (tx) =>
      tx.$executeRawUnsafe(`INSERT INTO ${APP_SCHEMA}.funnel_src (day) VALUES ('2000-01-01')`)
    ),
    /read-only/
  );
});

test("la consulta a la app se corta con statement_timeout", async () => {
  const started = Date.now();
  await assert.rejects(
    appFunnelFetcher(appUrl(SLOW_SCHEMA), { statementTimeoutMs: 200 })({ from: "2000-01-01", to: "2000-01-31" }),
    /statement timeout|canceling statement/
  );
  assert.ok(Date.now() - started < 2500, "debería cortar antes de que acabe pg_sleep(3)");
});

test("con SEO_ENV=test rechaza una APP_FUNNEL_DATABASE_URL de Neon", async () => {
  await assert.rejects(
    withAppFunnelReader("postgresql://lector@app.neon.tech/db", async () => 1),
    /neon\.tech/
  );
});
