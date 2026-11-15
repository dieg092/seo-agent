// src/collectors/bingWebmasterCollector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectBingWebmaster, parseBingDate, siteUrlOfQuery, type BingFetch } from "./bingWebmasterCollector";
import { prisma } from "../db";

const KEY = "clave-de-test-para-bing-0123456789abcdef";
// Fechas de 1999 para no pisar datos reales: los tests solo borran esas filas.
const D1 = Date.UTC(1999, 0, 4);
const D2 = Date.UTC(1999, 0, 11);
const wcf = (ms: number) => `/Date(${ms})/`;
const range = { gte: new Date(D1), lte: new Date(D2) };

async function cleanup() {
  await prisma.bingQueryStat.deleteMany({ where: { date: range } });
  await prisma.bingPageStat.deleteMany({ where: { date: range } });
  await prisma.bingCrawlStat.deleteMany({ where: { date: range } });
}

const stat = (Query: string, ms: number, Impressions: number, Clicks = 0, AvgImpressionPosition = 5, AvgClickPosition = -1) => ({
  Query,
  Date: wcf(ms),
  Impressions,
  Clicks,
  AvgImpressionPosition,
  AvgClickPosition,
});

test("parseBingDate lee la fecha WCF con y sin zona y la deja en día UTC", () => {
  assert.equal(parseBingDate("/Date(915408000000)/")?.toISOString(), "1999-01-04T00:00:00.000Z");
  assert.equal(parseBingDate("/Date(915408000000-0700)/")?.toISOString(), "1999-01-04T00:00:00.000Z");
  assert.equal(parseBingDate("2026-01-01"), null);
});

test("siteUrlOfQuery reconoce consultas que son URLs del sitio", () => {
  assert.equal(siteUrlOfQuery("miwebdeboda.com/ana-y-luis"), "https://miwebdeboda.com/ana-y-luis");
  assert.equal(siteUrlOfQuery("https://www.miwebdeboda.com/blog"), "https://www.miwebdeboda.com/blog");
  assert.equal(siteUrlOfQuery("web de boda"), null);
  assert.equal(siteUrlOfQuery("otrodominio.com/x"), null);
});

test("guarda consultas, páginas y rastreo; redacta las URLs privadas y suma las que coinciden", async () => {
  await cleanup();
  const privateSeen: string[] = [];
  const api: Record<string, unknown> = {
    GetQueryStats: [
      stat("Web de Boda", D1, 10, 1, 4, 3),
      stat("web de boda", D1, 10, 0, 6),
      stat("miwebdeboda.com/ana-y-luis-2027-06-12", D1, 3),
      stat("miwebdeboda", D2, 4),
      { ...stat("sin fecha", D1, 1), Date: "x" },
    ],
    GetPageStats: [stat("https://miwebdeboda.com/precios", D1, 7, 2, 3, 2), stat("https://miwebdeboda.com/ana-y-luis-2027-06-12/i/tok", D2, 2)],
    GetCrawlStats: [
      { Date: wcf(D1), CrawledPages: 30, InIndex: 3, InLinks: 3, Code2xx: 6, Code301: 0, Code302: 0, Code4xx: 0, Code5xx: 1, BlockedByRobotsTxt: 1, CrawlErrors: 0, AllOtherCodes: 22 },
    ],
  };
  const fetch: BingFetch = async (method, params) => {
    assert.equal(params.siteUrl, "https://miwebdeboda.com/");
    return api[method];
  };
  try {
    const r = await collectBingWebmaster({ fetch, privateKey: KEY, recordPrivate: async (url) => void privateSeen.push(url) });
    assert.deepEqual(r, { queries: 3, pages: 2, crawlDays: 1, privateSeen: 2 });

    const queries = await prisma.bingQueryStat.findMany({ where: { date: range }, orderBy: { query: "asc" } });
    const merged = queries.find((q) => q.query === "web de boda");
    assert.ok(merged);
    assert.equal(merged.impressions, 20);
    assert.equal(merged.clicks, 1);
    assert.equal(merged.avgImpressionPosition, 5);
    assert.equal(merged.avgClickPosition, 3);
    assert.equal(queries.find((q) => q.query === "miwebdeboda")?.isBrand, true);
    assert.ok(queries.every((q) => !q.query.includes("ana-y-luis")), "la consulta con URL privada queda redactada");
    assert.ok(queries.some((q) => q.query.includes("<privada:")));

    const pages = await prisma.bingPageStat.findMany({ where: { date: range } });
    assert.equal(pages.find((p) => p.page === "https://miwebdeboda.com/precios")?.avgClickPosition, 2);
    assert.ok(pages.every((p) => !p.page.includes("ana-y-luis")));
    assert.equal(privateSeen.length, 2);

    const crawl = await prisma.bingCrawlStat.findUnique({ where: { date: new Date(D1) } });
    assert.equal(crawl?.crawledPages, 30);
    assert.equal(crawl?.code5xx, 1);

    // Repetir no duplica: es upsert.
    await collectBingWebmaster({ fetch, privateKey: KEY, recordPrivate: async () => {} });
    assert.equal(await prisma.bingQueryStat.count({ where: { date: range } }), 3);
  } finally {
    await cleanup();
  }
});
