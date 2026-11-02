// src/collectors/urlInspectionCollector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import type { InspectionResult } from "../google/urlInspectionClient";
import {
  collectUrlInspections,
  fetchSitemapEntries,
  isQuotaExhausted,
  isSweepDay,
  selectForInspection,
} from "./urlInspectionCollector";

// Clave ficticia, solo para tests.
const KEY = "clave-ficticia-de-test-url-inspection";
process.env.SEO_PRIVATE_URL_KEY = KEY;

// Las URLs públicas de test van bajo /blog/test-insp-… (ruta que no existe) y los tests
// solo borran ese prefijo. Fechas de 2001: el domingo es el 1 de abril y el lunes, el 2.
const PREFIX = "https://miwebdeboda.com/blog/test-insp-";
const SUNDAY = new Date("2001-04-01T06:00:00Z");
const MONDAY = new Date("2001-04-02T06:00:00Z");
const OLD = new Date("2000-01-01T00:00:00Z");

async function cleanup() {
  await prisma.urlInspection.deleteMany({ where: { url: { startsWith: PREFIX } } });
}

const noAlert = async () => {};
const noSleep = async () => {};
const PASS: InspectionResult = { verdict: "PASS", coverageState: "Submitted and indexed", indexingState: "INDEXING_ALLOWED" };

function fakeInspect(calls: string[], behaviour: (url: string) => InspectionResult | Error = () => PASS) {
  return async (url: string): Promise<InspectionResult> => {
    calls.push(url);
    const r = behaviour(url);
    if (r instanceof Error) throw r;
    return r;
  };
}

test("orden por motivo", () => {
  const lastByUrl = new Map([
    [`${PREFIX}tracked`, { verdict: "NEUTRAL", inspectedAt: new Date("2001-03-30") }],
    [`${PREFIX}ok`, { verdict: "PASS", inspectedAt: new Date("2001-03-01") }],
  ]);
  const selected = selectForInspection({
    sitemap: [
      { url: `${PREFIX}sweep-nueva`, lastmod: OLD },
      { url: `${PREFIX}ok`, lastmod: OLD },
      { url: "https://miwebdeboda.com/precios", lastmod: OLD },
      { url: `${PREFIX}recent/`, lastmod: new Date("2001-03-25") },
      { url: `${PREFIX}tracked`, lastmod: OLD },
      { url: "https://miwebdeboda.com/", lastmod: null },
    ],
    // La primera ya está en el sitemap (con otra forma): no es huérfana.
    orphanWithImpressions: [`http://miwebdeboda.com/blog/test-insp-ok/`, `${PREFIX}huerfana`],
    lastByUrl,
    today: SUNDAY,
    fullSweep: true,
    budget: 100,
  });
  assert.deepEqual(
    selected.map((s) => [s.url, s.reason, s.inSitemap]),
    [
      [`${PREFIX}tracked`, "tracked", true],
      [`${PREFIX}recent/`, "recent", true],
      ["https://miwebdeboda.com/precios", "commercial", true],
      ["https://miwebdeboda.com/", "commercial", true],
      [`${PREFIX}huerfana`, "orphan", false],
      // Barrido: la nunca inspeccionada antes que la que ya tiene inspección.
      [`${PREFIX}sweep-nueva`, "sweep", true],
      [`${PREFIX}ok`, "sweep", true],
    ]
  );
});

test("sweep solo en domingo", async () => {
  assert.equal(isSweepDay(SUNDAY), true);
  assert.equal(isSweepDay(MONDAY), false);

  const sitemap = async () => [
    { url: `${PREFIX}vieja`, lastmod: OLD },
    { url: `${PREFIX}reciente`, lastmod: new Date("2001-03-31") },
  ];

  await cleanup();
  const monday: string[] = [];
  await collectUrlInspections({
    inspect: fakeInspect(monday),
    sitemap,
    orphans: async () => [],
    today: MONDAY,
    sleep: noSleep,
    alert: noAlert,
  });
  assert.deepEqual(monday, [`${PREFIX}reciente`]);

  await cleanup();
  const sunday: string[] = [];
  const r = await collectUrlInspections({
    inspect: fakeInspect(sunday),
    sitemap,
    orphans: async () => [],
    today: SUNDAY,
    sleep: noSleep,
    alert: noAlert,
  });
  assert.deepEqual(sunday, [`${PREFIX}reciente`, `${PREFIX}vieja`]);
  assert.equal(r.inspected, 2);
  const rows = await prisma.urlInspection.findMany({ where: { url: { startsWith: PREFIX } }, orderBy: { url: "asc" } });
  assert.deepEqual(
    rows.map((x) => [x.url, x.reason, x.verdict, x.inSitemap]),
    [
      [`${PREFIX}reciente`, "recent", "PASS", true],
      [`${PREFIX}vieja`, "sweep", "PASS", true],
    ]
  );
  await cleanup();
});

test("excluye privadas", async () => {
  const privateUrls = [
    "https://miwebdeboda.com/test-pareja-ficticia",
    "https://miwebdeboda.com/test-pareja-ficticia/i/token-ficticio",
    "https://miwebdeboda.com/admin/cuenta",
    "https://boda-ficticia.example/",
    "https://miwebdeboda.com/<privada:abcdef123456>",
  ];
  const lastByUrl = new Map(privateUrls.map((u) => [u, { verdict: "FAIL", inspectedAt: OLD }]));
  const selected = selectForInspection({
    sitemap: [...privateUrls.map((url) => ({ url, lastmod: new Date("2001-03-31") })), { url: `${PREFIX}publica`, lastmod: OLD }],
    orphanWithImpressions: privateUrls,
    lastByUrl,
    today: SUNDAY,
    fullSweep: true,
    budget: 100,
  });
  assert.deepEqual(selected.map((s) => s.url), [`${PREFIX}publica`]);

  await cleanup();
  const calls: string[] = [];
  await collectUrlInspections({
    inspect: fakeInspect(calls),
    sitemap: async () => privateUrls.map((url) => ({ url, lastmod: new Date("2001-03-31") })),
    orphans: async () => privateUrls,
    today: SUNDAY,
    sleep: noSleep,
    alert: noAlert,
  });
  assert.deepEqual(calls, []);
  await cleanup();
});

test("respeta el presupuesto", async () => {
  await cleanup();
  const calls: string[] = [];
  const r = await collectUrlInspections({
    inspect: fakeInspect(calls),
    sitemap: async () => [1, 2, 3, 4].map((n) => ({ url: `${PREFIX}p${n}`, lastmod: OLD })),
    orphans: async () => [],
    today: SUNDAY,
    budget: 2,
    sleep: noSleep,
    alert: noAlert,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(r, { inspected: 2, failed: 0, skippedForBudget: 2 });

  // Una segunda ejecución el mismo día ya no tiene presupuesto: no inspecciona nada.
  const again: string[] = [];
  const r2 = await collectUrlInspections({
    inspect: fakeInspect(again),
    sitemap: async () => [1, 2, 3, 4].map((n) => ({ url: `${PREFIX}p${n}`, lastmod: OLD })),
    orphans: async () => [],
    today: new Date(SUNDAY.getTime() + 60_000),
    budget: 2,
    sleep: noSleep,
    alert: noAlert,
  });
  assert.equal(again.length, 0);
  assert.equal(r2.skippedForBudget, 4);
  await cleanup();
});

test("un error no corta", async () => {
  await cleanup();
  const calls: string[] = [];
  const alerts: string[] = [];
  const r = await collectUrlInspections({
    inspect: fakeInspect(calls, (url) => (url.endsWith("p2") ? new Error("fallo ficticio 500") : PASS)),
    sitemap: async () => [1, 2, 3].map((n) => ({ url: `${PREFIX}p${n}`, lastmod: OLD })),
    orphans: async () => [],
    today: SUNDAY,
    sleep: noSleep,
    alert: async (a) => {
      alerts.push(a.type);
    },
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(r, { inspected: 2, failed: 1, skippedForBudget: 0 });
  const failed = await prisma.urlInspection.findFirst({ where: { url: `${PREFIX}p2` } });
  assert.equal(failed?.error, "fallo ficticio 500");
  assert.equal(failed?.verdict, null);
  assert.deepEqual(alerts, ["url-inspection-error"]);
  await cleanup();
});

test("para con 429", async () => {
  await cleanup();
  const calls: string[] = [];
  const alerts: string[] = [];
  const quota = Object.assign(new Error("Quota exceeded"), { code: 429 });
  const r = await collectUrlInspections({
    inspect: fakeInspect(calls, (url) => (url.endsWith("p2") ? quota : PASS)),
    sitemap: async () => [1, 2, 3, 4].map((n) => ({ url: `${PREFIX}p${n}`, lastmod: OLD })),
    orphans: async () => [],
    today: SUNDAY,
    sleep: noSleep,
    alert: async (a) => {
      alerts.push(a.type);
    },
  });
  // Para en la segunda: no pide la tercera ni la cuarta.
  assert.equal(calls.length, 2);
  assert.deepEqual(r, { inspected: 1, failed: 0, skippedForBudget: 3 });
  // Lo no inspeccionado no se guarda: no puede contar como desindexado.
  const rows = await prisma.urlInspection.findMany({ where: { url: { startsWith: PREFIX } } });
  assert.deepEqual(rows.map((x) => x.url), [`${PREFIX}p1`]);
  assert.deepEqual(alerts, ["url-inspection-quota"]);

  assert.equal(isQuotaExhausted({ status: "RESOURCE_EXHAUSTED", message: "x" }), true);
  assert.equal(isQuotaExhausted({ response: { status: 429 } }), true);
  assert.equal(isQuotaExhausted(new Error("fallo ficticio 500")), false);
  await cleanup();
});

test("la ultima inspeccion no PASS se vuelve a inspeccionar como tracked", async () => {
  await cleanup();
  await prisma.urlInspection.create({
    data: { url: `${PREFIX}seguida`, inspectedAt: new Date("2001-03-20"), inSitemap: true, reason: "sweep", verdict: "NEUTRAL" },
  });
  const calls: string[] = [];
  await collectUrlInspections({
    inspect: fakeInspect(calls),
    sitemap: async () => [{ url: `${PREFIX}seguida`, lastmod: OLD }],
    orphans: async () => [],
    today: MONDAY,
    sleep: noSleep,
    alert: noAlert,
  });
  assert.deepEqual(calls, [`${PREFIX}seguida`]);
  const last = await prisma.urlInspection.findFirst({ where: { url: `${PREFIX}seguida` }, orderBy: { inspectedAt: "desc" } });
  assert.equal(last?.reason, "tracked");
  await cleanup();
});

test("sin SEO_PRIVATE_URL_KEY falla antes de inspeccionar o escribir", async () => {
  delete process.env.SEO_PRIVATE_URL_KEY;
  try {
    const calls: string[] = [];
    await assert.rejects(
      collectUrlInspections({
        inspect: fakeInspect(calls),
        sitemap: async () => [{ url: `${PREFIX}p1`, lastmod: OLD }],
        orphans: async () => [],
        today: SUNDAY,
        sleep: noSleep,
        alert: noAlert,
      }),
      /SEO_PRIVATE_URL_KEY/
    );
    assert.equal(calls.length, 0);
  } finally {
    process.env.SEO_PRIVATE_URL_KEY = KEY;
  }
});

test("lee el sitemap y sus hijos con lastmod", async () => {
  const xml: Record<string, string> = {
    "https://miwebdeboda.com/sitemap.xml": `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://miwebdeboda.com/sitemap-blog.xml</loc></sitemap><sitemap><loc>https://otro.example/s.xml</loc></sitemap></sitemapindex>`,
    "https://miwebdeboda.com/sitemap-blog.xml": `<?xml version="1.0"?><urlset><url><loc>${PREFIX}a</loc><lastmod>2001-03-30</lastmod></url><url><loc>${PREFIX}b</loc></url></urlset>`,
  };
  const entries = await fetchSitemapEntries({
    baseUrl: "https://miwebdeboda.com/",
    fetchXml: async (url) => {
      if (!xml[url]) throw new Error(`no debería pedir ${url}`);
      return xml[url];
    },
  });
  assert.deepEqual(entries, [
    { url: `${PREFIX}a`, lastmod: new Date("2001-03-30") },
    { url: `${PREFIX}b`, lastmod: null },
  ]);
});
