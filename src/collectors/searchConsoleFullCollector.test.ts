// src/collectors/searchConsoleFullCollector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { DAILY_ROW_CAP, type GscGenericRow, type fetchSearchAnalytics } from "../google/searchConsoleClient";
import { decryptUrl, hmac12, redactUrl } from "../privacy/redact";
import { collectSearchConsoleFull, planFetchWindows } from "./searchConsoleFullCollector";

// Clave ficticia, solo para tests.
const KEY = "clave-ficticia-de-test-gsc-full";
process.env.SEO_PRIVATE_URL_KEY = KEY;

// Fechas de 2001: no existen datos reales ahí, así que los tests solo borran ese rango.
// Las páginas públicas van bajo /blog/test-… (ruta que no existe); las privadas, bajo
// /test-… (primer segmento desconocido → web de pareja) y se guardan redactadas.
const RANGE = { gte: new Date("2001-01-01"), lte: new Date("2001-12-31") };
const PUBLIC_PAGE = "https://miwebdeboda.com/blog/test-full-a";
const PRIVATE_PAGE = "https://miwebdeboda.com/test-pareja-ficticia/i/token-ficticio";

async function cleanup() {
  await prisma.searchConsolePageDaily.deleteMany({ where: { date: RANGE } });
  await prisma.searchConsoleQueryTyped.deleteMany({ where: { date: RANGE } });
  await prisma.searchConsoleSegmentDaily.deleteMany({ where: { date: RANGE } });
  await prisma.gscDataQuality.deleteMany({ where: { date: RANGE } });
  await prisma.privateIncident.deleteMany({ where: { urlHmac: hmac12(PRIVATE_PAGE, KEY) } });
}

type FetchParams = Parameters<typeof fetchSearchAnalytics>[0];
type FakeRow = { date: string; page: string; query?: string; device?: string; country?: string; clicks: number };

// fetch falso: devuelve las filas del rango pedido, con keys según las dimensiones.
function fakeFetch(
  rowsFor: (p: FetchParams) => FakeRow[],
  calls: FetchParams[] = [],
  rowsByDateOverride?: (p: FetchParams) => Map<string, number> | undefined
): typeof fetchSearchAnalytics {
  return async (p) => {
    calls.push(p);
    const rows: GscGenericRow[] = rowsFor(p)
      .filter((r) => r.date >= p.startDate && r.date <= p.endDate)
      .map((r) => {
        const keys: GscGenericRow["keys"] = {};
        for (const d of p.dimensions) {
          const v = d === "date" ? r.date : d === "page" ? r.page : r[d];
          if (v !== undefined) keys[d] = v;
        }
        return { keys, clicks: r.clicks, impressions: r.clicks * 10, ctr: 0.1, position: p.type === "discover" ? null : 3.5 };
      });
    const rowsByDate = new Map<string, number>();
    for (const r of rows) rowsByDate.set(r.keys.date!, (rowsByDate.get(r.keys.date!) ?? 0) + 1);
    return { rows, rowsByDate: rowsByDateOverride?.(p) ?? rowsByDate };
  };
}

const noAlert = async () => {};

test("planFetchWindows: provisionales los ultimos 4 dias y finaliza los no finales antiguos", () => {
  const today = new Date("2001-03-31T07:00:00Z");
  const existing = [
    { date: "2001-03-26", isFinal: false }, // provisional antiguo → se finaliza
    { date: "2001-03-25", isFinal: true }, // ya final → no se pide
    { date: "2001-03-28", isFinal: false }, // dentro de la ventana provisional
  ];
  const w = planFetchWindows({ today, existing, lookbackDays: 10 });
  assert.deepEqual(w.provisional, { start: "2001-03-27", end: "2001-03-30" });
  // 03-21..03-26 sin finalizar (huecos o provisionales), sin 03-25.
  assert.deepEqual(w.finalDates, ["2001-03-21", "2001-03-22", "2001-03-23", "2001-03-24", "2001-03-26"]);
});

test("guarda totales de los 6 tipos", async () => {
  await cleanup();
  try {
    const r = await collectSearchConsoleFull({
      today: new Date("2001-03-31T07:00:00Z"),
      alert: noAlert,
      recordPrivate: async () => {},
      fetch: fakeFetch((p) => [{ date: "2001-03-28", page: PUBLIC_PAGE, clicks: p.type.length }]),
    });
    const rows = await prisma.searchConsolePageDaily.findMany({
      where: { date: new Date("2001-03-28"), page: PUBLIC_PAGE },
      orderBy: { type: "asc" },
    });
    assert.deepEqual(
      rows.map((x) => x.type),
      ["discover", "googleNews", "image", "news", "video", "web"]
    );
    assert.ok(rows.every((x) => x.isFinal === false));
    assert.equal(rows.find((x) => x.type === "googleNews")?.clicks, "googleNews".length);
    assert.equal(rows.find((x) => x.type === "discover")?.position, null);
    assert.equal(r.pageDaily, 6);

    const quality = await prisma.gscDataQuality.findUnique({
      where: { date_type_dataset: { date: new Date("2001-03-28"), type: "web", dataset: "page" } },
    });
    assert.equal(quality?.rowsReturned, 1);
    assert.equal(quality?.pageTotalClicks, 3);
    assert.equal(quality?.queryDetailClicks, 0);
    assert.equal(quality?.isFinal, false);
  } finally {
    await cleanup();
  }
});

test("no pide query para discover ni googleNews", async () => {
  await cleanup();
  try {
    const calls: FetchParams[] = [];
    const r = await collectSearchConsoleFull({
      today: new Date("2001-03-31T07:00:00Z"),
      alert: noAlert,
      recordPrivate: async () => {},
      fetch: fakeFetch(
        (p) => [{ date: "2001-03-29", page: PUBLIC_PAGE, query: "mi web de boda fotos", device: "MOBILE", country: "esp", clicks: 2 }],
        calls
      ),
    });
    const withQuery = calls.filter((c) => c.dimensions.includes("query"));
    assert.ok(withQuery.length > 0);
    assert.deepEqual([...new Set(withQuery.map((c) => c.type))].sort(), ["image", "video"]);
    const withDevice = calls.filter((c) => c.dimensions.includes("device"));
    assert.deepEqual([...new Set(withDevice.map((c) => c.type))], ["web"]);

    const q = await prisma.searchConsoleQueryTyped.findFirst({
      where: { date: new Date("2001-03-29"), page: PUBLIC_PAGE, type: "image" },
    });
    assert.equal(q?.query, "mi web de boda fotos");
    assert.equal(q?.isBrand, true);
    const s = await prisma.searchConsoleSegmentDaily.findFirst({
      where: { date: new Date("2001-03-29"), page: PUBLIC_PAGE },
    });
    assert.equal(s?.device, "MOBILE");
    assert.equal(s?.country, "esp");
    assert.equal(r.queryRows, 2);
    assert.equal(r.segmentRows, 1);
  } finally {
    await cleanup();
  }
});

test("provisional pasa a final sin duplicar", async () => {
  await cleanup();
  try {
    const where = { date: new Date("2001-03-27"), page: PUBLIC_PAGE, type: "web" };
    await collectSearchConsoleFull({
      today: new Date("2001-03-31T07:00:00Z"),
      alert: noAlert,
      recordPrivate: async () => {},
      fetch: fakeFetch(() => [{ date: "2001-03-27", page: PUBLIC_PAGE, clicks: 5 }]),
    });
    const before = await prisma.searchConsolePageDaily.findMany({ where });
    assert.equal(before.length, 1);
    assert.equal(before[0].isFinal, false);
    assert.equal(before[0].clicks, 5);

    // Al día siguiente, 03-27 tiene más de 4 días: se vuelve a pedir con "final".
    const calls: FetchParams[] = [];
    await collectSearchConsoleFull({
      today: new Date("2001-04-01T07:00:00Z"),
      alert: noAlert,
      recordPrivate: async () => {},
      fetch: fakeFetch((p) => [{ date: "2001-03-27", page: PUBLIC_PAGE, clicks: p.dataState === "final" ? 7 : 99 }], calls),
    });
    assert.ok(
      calls.some((c) => c.dataState === "final" && c.startDate <= "2001-03-27" && c.endDate >= "2001-03-27")
    );
    const after = await prisma.searchConsolePageDaily.findMany({ where });
    assert.equal(after.length, 1);
    assert.equal(after[0].isFinal, true);
    assert.equal(after[0].clicks, 7);

    const quality = await prisma.gscDataQuality.findMany({
      where: { date: new Date("2001-03-27"), type: "web", dataset: "page" },
    });
    assert.equal(quality.length, 1);
    assert.equal(quality[0].isFinal, true);
  } finally {
    await cleanup();
  }
});

test("url privada se guarda redactada y llama a recordPrivate", async () => {
  await cleanup();
  try {
    const recorded: [string, string][] = [];
    const r = await collectSearchConsoleFull({
      today: new Date("2001-03-31T07:00:00Z"),
      alert: noAlert,
      recordPrivate: async (url, source) => {
        recorded.push([url, source]);
      },
      fetch: fakeFetch((p) =>
        p.type === "web" ? [{ date: "2001-03-28", page: PRIVATE_PAGE, device: "DESKTOP", country: "esp", clicks: 1 }] : []
      ),
    });
    assert.equal(r.privateSeen, 1);
    assert.deepEqual(recorded, [[PRIVATE_PAGE, "gsc:web"]]);

    const day = new Date("2001-03-28");
    const pages = [
      ...(await prisma.searchConsolePageDaily.findMany({ where: { date: day } })),
      ...(await prisma.searchConsoleSegmentDaily.findMany({ where: { date: day } })),
    ].map((x) => x.page);
    assert.equal(pages.length, 2);
    for (const page of pages) {
      assert.equal(page, redactUrl(PRIVATE_PAGE, KEY));
      assert.ok(!page.includes("test-pareja"));
      assert.ok(!page.includes("token-ficticio"));
    }
  } finally {
    await cleanup();
  }
});

test("sin recordPrivate, la url privada crea un PrivateIncident cifrado y una sola alerta", async () => {
  await cleanup();
  try {
    const alerts: { type: string; subject: string; body: string }[] = [];
    const alert = async (a: { type: string; subject: string; body: string }) => {
      alerts.push(a);
    };
    const fetch = fakeFetch((p) =>
      p.type === "web" || p.type === "image" ? [{ date: "2001-03-28", page: PRIVATE_PAGE, clicks: 1 }] : []
    );
    await collectSearchConsoleFull({ today: new Date("2001-03-31T07:00:00Z"), alert, fetch });

    const incident = await prisma.privateIncident.findUnique({ where: { urlHmac: hmac12(PRIVATE_PAGE, KEY) } });
    assert.ok(incident);
    assert.equal(decryptUrl(incident.urlEncrypted, KEY), PRIVATE_PAGE);
    assert.deepEqual([...incident.sources].sort(), ["gsc:image", "gsc:web"]);

    const privateAlerts = alerts.filter((a) => a.type === "private-url-exposed");
    assert.equal(privateAlerts.length, 1);
    assert.ok(!privateAlerts[0].body.includes("test-pareja"));

    // Otra ejecución con el incidente abierto no vuelve a avisar.
    alerts.length = 0;
    await collectSearchConsoleFull({ today: new Date("2001-03-31T07:00:00Z"), alert, fetch });
    assert.equal(alerts.filter((a) => a.type === "private-url-exposed").length, 0);
  } finally {
    await cleanup();
  }
});

test("marca capped y alerta", async () => {
  await cleanup();
  try {
    const alerts: { type: string; body: string }[] = [];
    const r = await collectSearchConsoleFull({
      today: new Date("2001-03-31T07:00:00Z"),
      alert: async (a) => {
        alerts.push(a);
      },
      recordPrivate: async () => {},
      fetch: fakeFetch(
        () => [{ date: "2001-03-29", page: PUBLIC_PAGE, device: "MOBILE", country: "esp", clicks: 1 }],
        [],
        (p) =>
          p.type === "web" && p.dimensions.includes("device") && p.dataState === "all"
            ? new Map([["2001-03-29", DAILY_ROW_CAP]])
            : undefined
      ),
    });
    assert.equal(r.capped, 1);
    const q = await prisma.gscDataQuality.findUnique({
      where: { date_type_dataset: { date: new Date("2001-03-29"), type: "web", dataset: "segment" } },
    });
    assert.equal(q?.capped, true);
    assert.equal(q?.rowsReturned, DAILY_ROW_CAP);
    const pageQ = await prisma.gscDataQuality.findUnique({
      where: { date_type_dataset: { date: new Date("2001-03-29"), type: "web", dataset: "page" } },
    });
    assert.equal(pageQ?.capped, false);
    const capAlerts = alerts.filter((a) => a.type === "gsc-row-cap");
    assert.equal(capAlerts.length, 1);
    assert.match(capAlerts[0].body, /2001-03-29 segment:web/);
  } finally {
    await cleanup();
  }
});

test("un dataset que falla no corta los demas y reintenta con 429", async () => {
  await cleanup();
  try {
    const alerts: { type: string }[] = [];
    let rateLimited = 0;
    const base = fakeFetch(() => [{ date: "2001-03-29", page: PUBLIC_PAGE, clicks: 1 }]);
    const sleeps: number[] = [];
    const r = await collectSearchConsoleFull({
      today: new Date("2001-03-31T07:00:00Z"),
      alert: async (a) => {
        alerts.push(a);
      },
      recordPrivate: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async (p) => {
        if (p.type === "news") throw new Error("fallo ficticio");
        if (p.type === "video" && p.dimensions.length === 2 && p.dataState === "all" && rateLimited < 2) {
          rateLimited += 1;
          throw Object.assign(new Error("Too Many Requests"), { code: 429 });
        }
        return base(p);
      },
    });
    assert.equal(r.failed, 2); // news: ventana final y provisional
    assert.deepEqual(sleeps, [1000, 2000]);
    const types = (
      await prisma.searchConsolePageDaily.findMany({ where: { date: new Date("2001-03-29"), page: PUBLIC_PAGE } })
    ).map((x) => x.type);
    assert.ok(types.includes("video"));
    assert.ok(types.includes("discover"));
    assert.ok(!types.includes("news"));
    assert.equal(alerts.filter((a) => a.type === "gsc-full-fetch-error").length, 1);
  } finally {
    await cleanup();
  }
});

test("sin SEO_PRIVATE_URL_KEY falla antes de pedir ni escribir nada", async () => {
  const saved = process.env.SEO_PRIVATE_URL_KEY;
  delete process.env.SEO_PRIVATE_URL_KEY;
  try {
    let called = false;
    await assert.rejects(
      collectSearchConsoleFull({
        today: new Date("2001-03-31T07:00:00Z"),
        alert: noAlert,
        fetch: async () => {
          called = true;
          return { rows: [], rowsByDate: new Map() };
        },
      }),
      /SEO_PRIVATE_URL_KEY/
    );
    assert.equal(called, false);
  } finally {
    process.env.SEO_PRIVATE_URL_KEY = saved;
  }
});
