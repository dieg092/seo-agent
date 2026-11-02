// scripts/fix-public-misredacted.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { encryptUrl, hmac12 } from "../src/privacy/redact";
import { SITE_ORIGIN } from "../src/privacy/sitePrivacy";
import { fixPublicMisredacted } from "./fix-public-misredacted";

// Clave ficticia, solo para tests. Fechas de 2001 para no chocar con otros tests.
const KEY = "clave-ficticia-de-test-fix-redaccion";
const PUBLIC_URL = "https://miwebdeboda.com/tool";
const HMAC = hmac12(PUBLIC_URL, KEY);
const REDACTED = `${SITE_ORIGIN}/<privada:${HMAC}>`;
// Otra privada redactada que no se debe tocar.
const OTHER_REDACTED = `${SITE_ORIGIN}/<privada:${hmac12("https://miwebdeboda.com/pareja-ficticia", KEY)}>`;
const D1 = new Date("2001-03-01T00:00:00Z");
const D2 = new Date("2001-03-02T00:00:00Z");
const RUN_AT = new Date("2001-03-03T00:00:00Z");
const NOW = new Date("2001-03-04T00:00:00Z");

const pages = [REDACTED, OTHER_REDACTED, PUBLIC_URL];
const metrics = { clicks: 1, impressions: 10, ctr: 0.1, position: 5 };

async function cleanup() {
  const inDates = { date: { in: [D1, D2] } };
  await prisma.searchConsolePageDaily.deleteMany({ where: { page: { in: pages }, ...inDates } });
  await prisma.searchConsoleSegmentDaily.deleteMany({ where: { page: { in: pages }, ...inDates } });
  await prisma.searchConsoleQueryTyped.deleteMany({ where: { page: { in: pages }, ...inDates } });
  await prisma.urlInspection.deleteMany({ where: { inspectedAt: RUN_AT } });
  await prisma.productionProbeResult.deleteMany({ where: { runAt: RUN_AT } });
  await prisma.privateIncident.deleteMany({ where: { urlHmac: HMAC } });
}

async function seed() {
  await prisma.searchConsolePageDaily.createMany({
    data: [
      { date: D1, page: REDACTED, type: "web", ...metrics },
      // D2 ya tiene la fila pública (recogida tras la corrección): la redactada sobra.
      { date: D2, page: REDACTED, type: "web", ...metrics },
      { date: D2, page: PUBLIC_URL, type: "web", ...metrics, clicks: 7 },
      { date: D1, page: OTHER_REDACTED, type: "web", ...metrics },
    ],
  });
  await prisma.searchConsoleSegmentDaily.createMany({
    data: [{ date: D1, page: REDACTED, device: "MOBILE", country: "esp", type: "web", ...metrics }],
  });
  await prisma.searchConsoleQueryTyped.createMany({
    data: [{ date: D1, page: REDACTED, query: "herramienta boda", type: "image", ...metrics }],
  });
  await prisma.urlInspection.createMany({
    data: [
      { url: REDACTED, inspectedAt: RUN_AT, inSitemap: true, reason: "tracked", googleCanonical: REDACTED },
      { url: OTHER_REDACTED, inspectedAt: RUN_AT, inSitemap: false, reason: "orphan" },
    ],
  });
  await prisma.productionProbeResult.createMany({
    data: [{ runAt: RUN_AT, url: REDACTED, kind: "sitemap", ok: false, reason: "privada en el sitemap" }],
  });
  await prisma.privateIncident.create({
    data: { urlHmac: HMAC, urlEncrypted: encryptUrl(PUBLIC_URL, KEY), sources: ["gsc:web"] },
  });
}

test("fixPublicMisredacted en --dry solo cuenta", async () => {
  await cleanup();
  try {
    await seed();
    const { totals, results } = await fixPublicMisredacted({ urls: [PUBLIC_URL], key: KEY, now: NOW });
    assert.deepEqual(totals, {
      pageDaily: 2,
      segmentDaily: 1,
      queryTyped: 1,
      urlInspection: 1,
      productionProbe: 1,
      incidentsResolved: 1,
    });
    assert.equal(results[0].url, PUBLIC_URL);
    assert.equal(await prisma.searchConsolePageDaily.count({ where: { page: REDACTED } }), 2);
    const incident = await prisma.privateIncident.findUnique({ where: { urlHmac: HMAC } });
    assert.equal(incident?.resolvedAt, null);
  } finally {
    await cleanup();
  }
});

test("fixPublicMisredacted con --apply reescribe y resuelve el incidente", async () => {
  await cleanup();
  try {
    await seed();
    // La URL con barra final y parámetros de seguimiento es la misma página.
    await fixPublicMisredacted({
      urls: [`${PUBLIC_URL}/?utm_source=ig&fbclid=x`, "https://miwebdeboda.com/tool/experiment"],
      apply: true,
      key: KEY,
      now: NOW,
    });

    assert.equal(await prisma.searchConsolePageDaily.count({ where: { page: REDACTED } }), 0);
    assert.equal(await prisma.searchConsoleSegmentDaily.count({ where: { page: REDACTED } }), 0);
    assert.equal(await prisma.searchConsoleQueryTyped.count({ where: { page: REDACTED } }), 0);
    const pageRows = await prisma.searchConsolePageDaily.findMany({
      where: { page: PUBLIC_URL, date: { in: [D1, D2] } },
      orderBy: { date: "asc" },
    });
    assert.equal(pageRows.length, 2);
    assert.equal(pageRows[1].clicks, 7, "se conserva la fila pública ya existente");
    assert.equal(await prisma.searchConsoleSegmentDaily.count({ where: { page: PUBLIC_URL, date: D1 } }), 1);
    assert.equal(await prisma.searchConsoleQueryTyped.count({ where: { page: PUBLIC_URL, date: D1 } }), 1);

    const inspection = await prisma.urlInspection.findFirst({ where: { inspectedAt: RUN_AT, reason: "tracked" } });
    assert.equal(inspection?.url, PUBLIC_URL);
    assert.equal(inspection?.googleCanonical, PUBLIC_URL);
    const probe = await prisma.productionProbeResult.findFirst({ where: { runAt: RUN_AT } });
    assert.equal(probe?.url, PUBLIC_URL);

    const incident = await prisma.privateIncident.findUnique({ where: { urlHmac: HMAC } });
    assert.equal(incident?.resolvedAt?.toISOString(), NOW.toISOString());

    // Lo de otras URLs privadas no se toca.
    assert.equal(await prisma.searchConsolePageDaily.count({ where: { page: OTHER_REDACTED, date: D1 } }), 1);
    assert.equal(await prisma.urlInspection.count({ where: { url: OTHER_REDACTED, inspectedAt: RUN_AT } }), 1);
  } finally {
    await cleanup();
  }
});

test("fixPublicMisredacted usa el sitemap por defecto y omite las privadas", async () => {
  await cleanup();
  try {
    await seed();
    const { totals, skippedPrivate } = await fixPublicMisredacted({
      key: KEY,
      now: NOW,
      sitemapUrls: async () => [PUBLIC_URL, "https://miwebdeboda.com/pareja-ficticia"],
    });
    assert.equal(totals.pageDaily, 2);
    assert.equal(skippedPrivate, 1);
  } finally {
    await cleanup();
  }
});
