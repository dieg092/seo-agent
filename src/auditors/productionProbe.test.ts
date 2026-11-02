// src/auditors/productionProbe.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { hmac12, redactUrl } from "../privacy/redact";
import { evaluateProbe, parsePrivateProbeUrls, probeProduction, type FetchedPage } from "./productionProbe";

// Clave ficticia, solo para tests.
const KEY = "clave-ficticia-de-test-sonda";
process.env.SEO_PRIVATE_URL_KEY = KEY;

// Las filas de la sonda se guardan con runAt en 2001: los tests solo borran ese rango.
const RUN_AT = new Date("2001-06-01T05:00:00Z");
const RUN_RANGE = { gte: new Date("2001-01-01"), lte: new Date("2001-12-31") };
const PUBLIC_URL = "https://miwebdeboda.com/blog/test-sonda";
const PRIVATE_URL = "https://miwebdeboda.com/test-pareja-sonda";
const SAMPLE_URL = "https://miwebdeboda.com/test-pareja-sonda/i/token-ficticio";

async function cleanup() {
  await prisma.productionProbeResult.deleteMany({ where: { runAt: RUN_RANGE } });
}

function page(p: Partial<FetchedPage> & { html?: string } = {}): FetchedPage {
  return { status: 200, finalUrl: PUBLIC_URL, headers: { "content-type": "text/html" }, html: "", ...p };
}

function html(head: string): string {
  return `<!doctype html><html><head>${head}</head><body>hola</body></html>`;
}

const selfCanonical = `<link rel="canonical" href="${PUBLIC_URL}">`;

test("sitemap correcto es ok", () => {
  const r = evaluateProbe("sitemap", PUBLIC_URL, page({ html: html(selfCanonical) }));
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  // La canónica con barra final y http es la misma URL.
  const r2 = evaluateProbe("sitemap", PUBLIC_URL, page({ html: html(`<link rel="canonical" href="http://miwebdeboda.com/blog/test-sonda/">`) }));
  assert.equal(r2.ok, true);
});

test("sitemap con noindex no es ok", () => {
  const meta = evaluateProbe("sitemap", PUBLIC_URL, page({ html: html(`<meta name="robots" content="noindex, follow">${selfCanonical}`) }));
  assert.equal(meta.ok, false);
  assert.equal(meta.reason, "noindex");
  assert.equal(meta.metaRobots, "noindex, follow");

  const header = evaluateProbe(
    "sitemap",
    PUBLIC_URL,
    page({ headers: { "content-type": "text/html", "x-robots-tag": "noindex" }, html: html(selfCanonical) })
  );
  assert.equal(header.ok, false);
  assert.equal(header.xRobotsTag, "noindex");
});

test("canonica a otra url no es ok", () => {
  const r = evaluateProbe("sitemap", PUBLIC_URL, page({ html: html(`<link rel="canonical" href="https://miwebdeboda.com/blog/otra">`) }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "canonica a otra url");
});

test("sitemap con redireccion, error o sin canonica no es ok", () => {
  const redirect = evaluateProbe("sitemap", PUBLIC_URL, page({ finalUrl: "https://miwebdeboda.com/blog", html: html(selfCanonical) }));
  assert.equal(redirect.reason, "redirige a otra url");
  const notFound = evaluateProbe("sitemap", PUBLIC_URL, page({ status: 404 }));
  assert.equal(notFound.reason, "status 404");
  const noCanonical = evaluateProbe("sitemap", PUBLIC_URL, page({ html: html("") }));
  assert.equal(noCanonical.reason, "sin canonica");
});

test("muestra privada con noindex es ok", () => {
  const r = evaluateProbe("private-sample", SAMPLE_URL, page({ finalUrl: SAMPLE_URL, html: html(`<meta name="robots" content="noindex">`) }));
  assert.equal(r.ok, true);
  // 404 y redirección al login también valen.
  assert.equal(evaluateProbe("private-sample", SAMPLE_URL, page({ status: 404, finalUrl: SAMPLE_URL })).ok, true);
  assert.equal(
    evaluateProbe("private-sample", "https://miwebdeboda.com/admin/cuenta", page({ finalUrl: "https://miwebdeboda.com/login?next=/admin" })).ok,
    true
  );
});

test("muestra privada 200 sin noindex no es ok", () => {
  const r = evaluateProbe("private-sample", SAMPLE_URL, page({ finalUrl: SAMPLE_URL, html: html("") }));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /sin noindex/);
});

test("parsePrivateProbeUrls separa por comas y espacios", () => {
  assert.deepEqual(parsePrivateProbeUrls(" https://a.test/x, https://b.test/y\nhttps://c.test "), [
    "https://a.test/x",
    "https://b.test/y",
    "https://c.test",
  ]);
  assert.deepEqual(parsePrivateProbeUrls(undefined), []);
});

test("privada en el sitemap llama a record", async () => {
  await cleanup();
  try {
    const recorded: { url: string; source: string }[] = [];
    const fetched: string[] = [];
    const { results, failures } = await probeProduction({
      now: RUN_AT,
      sitemapUrls: async () => [PUBLIC_URL, PRIVATE_URL],
      fetchPage: async (url) => {
        fetched.push(url);
        return page({ finalUrl: url, html: html(selfCanonical) });
      },
      privateSamples: [],
      gscPrivatePages: async () => [],
      record: async (url, source) => {
        recorded.push({ url, source });
        return { isNew: true };
      },
    });

    assert.deepEqual(recorded, [{ url: PRIVATE_URL, source: "probe:sitemap" }]);
    assert.deepEqual(fetched, [PUBLIC_URL], "la privada no se abre");
    const privateRow = results.find((r) => r.url === PRIVATE_URL);
    assert.equal(privateRow?.ok, false);
    assert.equal(privateRow?.reason, "privada en el sitemap");
    // Sin muestras: fila PENDIENTE B1 en verde.
    const pending = results.find((r) => r.kind === "private-sample");
    assert.equal(pending?.ok, true);
    assert.equal(pending?.reason, "PENDIENTE B1");
    assert.equal(failures, 1);

    // En la BD, la privada está redactada.
    const rows = await prisma.productionProbeResult.findMany({ where: { runAt: RUN_AT } });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => !r.url.includes("test-pareja")));
    assert.ok(rows.some((r) => r.url === `https://miwebdeboda.com/<privada:${hmac12(PRIVATE_URL, KEY)}>`));
  } finally {
    await cleanup();
  }
});

test("muestras privadas: indexable o en el sitemap se registra; gsc-private siempre en rojo", async () => {
  await cleanup();
  try {
    const recorded: { url: string; source: string }[] = [];
    const okSample = "https://miwebdeboda.com/test-pareja-sonda-ok";
    const gscRedacted = `https://miwebdeboda.com/<privada:${hmac12("https://miwebdeboda.com/test-gsc-sonda", KEY)}>`;
    const { results, failures } = await probeProduction({
      now: RUN_AT,
      sitemapUrls: async () => [],
      fetchPage: async (url) =>
        url === okSample
          ? page({ finalUrl: url, html: html(`<meta name="robots" content="noindex">`) })
          : page({ finalUrl: url, html: html(`<link rel="canonical" href="${url}">`) }),
      privateSamples: [SAMPLE_URL, okSample],
      gscPrivatePages: async () => [gscRedacted],
      record: async (url, source) => {
        recorded.push({ url, source });
        return { isNew: true };
      },
    });

    assert.deepEqual(recorded, [{ url: SAMPLE_URL, source: "probe:private-sample" }]);
    assert.equal(results.find((r) => r.url === okSample)?.ok, true);
    const gscRow = results.find((r) => r.kind === "gsc-private");
    assert.equal(gscRow?.ok, false);
    assert.equal(failures, 2);

    const rows = await prisma.productionProbeResult.findMany({ where: { runAt: RUN_AT } });
    assert.ok(rows.every((r) => !r.url.includes("test-")), "ninguna URL privada en claro");
    assert.ok(rows.every((r) => !(r.canonical ?? "").includes("test-")), "ni en la canónica");
    assert.ok(rows.some((r) => r.url === redactUrl(SAMPLE_URL, KEY)));
    assert.ok(rows.some((r) => r.url === gscRedacted));
  } finally {
    await cleanup();
  }
});

test("los incidentes gsc abiertos salen como gsc-private", async () => {
  const gscUrl = "https://miwebdeboda.com/test-gsc-sonda-incidente";
  const probeUrl = "https://miwebdeboda.com/test-probe-sonda-incidente";
  const hmacs = [hmac12(gscUrl, KEY), hmac12(probeUrl, KEY)];
  const cleanIncidents = () => prisma.privateIncident.deleteMany({ where: { urlHmac: { in: hmacs } } });
  const todayRunAt = new Date();
  await cleanup();
  await cleanIncidents();
  try {
    // Vistos un minuto antes de la ejecución de hoy, dentro de la ventana de 28 días.
    const now = new Date(todayRunAt.getTime() - 60_000);
    await prisma.privateIncident.create({
      data: { urlHmac: hmacs[0], urlEncrypted: "x", firstSeenAt: now, lastSeenAt: now, sources: ["gsc:web"] },
    });
    await prisma.privateIncident.create({
      data: { urlHmac: hmacs[1], urlEncrypted: "x", firstSeenAt: now, lastSeenAt: now, sources: ["probe:sitemap"] },
    });
    const { results } = await probeProduction({
      now: RUN_AT,
      sitemapUrls: async () => [],
      fetchPage: async () => page(),
      privateSamples: [],
      record: async () => ({ isNew: false }),
    });
    // RUN_AT es de 2001: la ventana de 28 días se calcula desde ahí, así que se repite con hoy.
    assert.equal(results.filter((r) => r.kind === "gsc-private").length, 0);

    const today = await probeProduction({
      now: todayRunAt,
      sitemapUrls: async () => [],
      fetchPage: async () => page(),
      privateSamples: [],
      record: async () => ({ isNew: false }),
    });
    const gscRows = today.results.filter((r) => r.kind === "gsc-private").map((r) => r.url);
    assert.ok(gscRows.includes(`https://miwebdeboda.com/<privada:${hmacs[0]}>`));
    assert.ok(!gscRows.includes(`https://miwebdeboda.com/<privada:${hmacs[1]}>`), "solo origen GSC");
  } finally {
    // La segunda ejecución guardó filas con runAt de hoy: se borran solo las suyas.
    await prisma.productionProbeResult.deleteMany({ where: { runAt: todayRunAt } });
    await cleanIncidents();
    await cleanup();
  }
});
