import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractCollectorFindings,
  extractCrawlFindings,
  extractDataQualityFindings,
  extractFunnelFindings,
  extractGscSitemapFindings,
  extractIndexBloatFindings,
  extractIndexationFindings,
  extractPrivacyFindings,
  extractSegmentFindings,
  extractVisibilityFindings,
  normalizeUrl,
  type CrawlRow,
  type InspectionRow,
} from "./annexB";
import { getCatalogEntry } from "../prioritization/catalog";

const NOW = new Date("2026-11-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);
const SITE = "https://www.miwebdeboda.com";

function insp(over: Partial<InspectionRow>): InspectionRow {
  return {
    id: Math.random().toString(36).slice(2),
    url: `${SITE}/blog/a`,
    inspectedAt: daysAgo(1),
    inSitemap: true,
    verdict: "PASS",
    coverageState: "Submitted and indexed",
    indexingState: "INDEXING_ALLOWED",
    robotsTxtState: "ALLOWED",
    pageFetchState: "SUCCESSFUL",
    googleCanonical: null,
    userCanonical: null,
    richResultsVerdict: null,
    richResultsItems: null,
    error: null,
    ...over,
  };
}

const types = (fs: { findingType: string }[]) => fs.map((f) => f.findingType).sort();

test("normalizeUrl ignora barra final, fragmento y mayúsculas del host", () => {
  assert.equal(normalizeUrl("https://WWW.Miwebdeboda.com/precios/#x"), "https://www.miwebdeboda.com/precios");
  assert.equal(normalizeUrl("https://www.miwebdeboda.com/"), "https://www.miwebdeboda.com/");
});

test("index-dropped: PASS antes, no PASS ahora y con impresiones", () => {
  const rows = [insp({ inspectedAt: daysAgo(8) }), insp({ inspectedAt: daysAgo(1), verdict: "NEUTRAL", coverageState: "Crawled - currently not indexed" })];
  const withImpr = extractIndexationFindings(rows, new Map([[`${SITE}/blog/a`, 40]]), NOW);
  assert.deepEqual(types(withImpr), ["index-dropped"]);
  assert.equal(extractIndexationFindings(rows, new Map(), NOW).length, 0);
});

test("index-not-indexed: dos inspecciones sin PASS y conocida hace más de 14 días", () => {
  const old = [insp({ inspectedAt: daysAgo(20), verdict: "NEUTRAL" }), insp({ inspectedAt: daysAgo(2), verdict: "NEUTRAL" })];
  assert.deepEqual(types(extractIndexationFindings(old, new Map(), NOW)), ["index-not-indexed"]);
  const fresh = [insp({ inspectedAt: daysAgo(5), verdict: "NEUTRAL" }), insp({ inspectedAt: daysAgo(2), verdict: "NEUTRAL" })];
  assert.equal(extractIndexationFindings(fresh, new Map(), NOW).length, 0);
});

test("las inspecciones con error no cuentan", () => {
  const rows = [insp({ inspectedAt: daysAgo(20), verdict: "NEUTRAL" }), insp({ inspectedAt: daysAgo(2), verdict: "NEUTRAL", error: "quota" })];
  assert.equal(extractIndexationFindings(rows, new Map(), NOW).length, 0);
});

test("index-canonical-mismatch tras normalizar", () => {
  const same = [insp({ googleCanonical: `${SITE}/blog/a/`, userCanonical: `${SITE}/blog/a` })];
  assert.equal(extractIndexationFindings(same, new Map(), NOW).length, 0);
  const diff = [insp({ googleCanonical: `${SITE}/blog/b`, userCanonical: `${SITE}/blog/a` })];
  assert.deepEqual(types(extractIndexationFindings(diff, new Map(), NOW)), ["index-canonical-mismatch"]);
});

test("index-blocked por robots, indexación o descarga, solo si está en el sitemap", () => {
  const unknown = insp({ robotsTxtState: "ROBOTS_TXT_STATE_UNSPECIFIED", indexingState: "INDEXING_STATE_UNSPECIFIED", pageFetchState: "PAGE_FETCH_STATE_UNSPECIFIED", verdict: "NEUTRAL" });
  assert.equal(extractIndexationFindings([unknown], new Map(), NOW).length, 0);
  for (const over of [{ robotsTxtState: "DISALLOWED" }, { indexingState: "BLOCKED_BY_META_TAG" }, { pageFetchState: "NOT_FOUND" }]) {
    assert.ok(types(extractIndexationFindings([insp(over)], new Map(), NOW)).includes("index-blocked"));
    assert.equal(extractIndexationFindings([insp({ ...over, inSitemap: false })], new Map(), NOW).filter((f) => f.findingType === "index-blocked").length, 0);
  }
});

test("rich-results-error ignora FAQ y HowTo", () => {
  const faq = insp({ richResultsVerdict: "FAIL", richResultsItems: [{ richResultType: "FAQ" }] });
  assert.equal(extractIndexationFindings([faq], new Map(), NOW).length, 0);
  const product = insp({ richResultsVerdict: "FAIL", richResultsItems: [{ richResultType: "Product snippets" }, { richResultType: "FAQ" }] });
  const out = extractIndexationFindings([product], new Map(), NOW);
  assert.deepEqual(types(out), ["rich-results-error"]);
  assert.deepEqual((out[0].detail as { types: string[] }).types, ["Product snippets"]);
});

test("sitemap-gsc-error: errores, pendiente más de 7 días o sin descargar en 14", () => {
  const base = { path: "/sitemap.xml", errors: 0, isPending: false, lastDownloaded: daysAgo(1) };
  assert.equal(extractGscSitemapFindings([{ id: "1", checkedAt: daysAgo(1), ...base }], NOW).length, 0);
  assert.equal(extractGscSitemapFindings([{ id: "1", checkedAt: daysAgo(1), ...base, errors: 2 }], NOW).length, 1);
  assert.equal(extractGscSitemapFindings([{ id: "1", checkedAt: daysAgo(1), ...base, lastDownloaded: daysAgo(20) }], NOW).length, 1);
  const pending = [
    { id: "1", checkedAt: daysAgo(10), ...base, isPending: true },
    { id: "2", checkedAt: daysAgo(1), ...base, isPending: true },
  ];
  assert.equal(extractGscSitemapFindings(pending, NOW).length, 1);
  const recovered = [...pending, { id: "3", checkedAt: daysAgo(0.5), ...base }];
  assert.equal(extractGscSitemapFindings(recovered, NOW).length, 0);
});

test("private-page-exposed solo con incidentes abiertos y sin la URL", () => {
  const out = extractPrivacyFindings([
    { id: "a", urlHmac: "abc123def456ghi", sources: ["gsc"], resolvedAt: null },
    { id: "b", urlHmac: "zzz", sources: ["probe"], resolvedAt: daysAgo(1) },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].findingType, "private-page-exposed");
  assert.ok(!JSON.stringify(out[0]).includes("http"));
  assert.equal(getCatalogEntry("private-page-exposed").severity, "critical");
});

function crawl(path: string, over: Partial<CrawlRow> = {}): CrawlRow {
  return {
    id: path,
    url: `${SITE}${path}`,
    inSitemap: true,
    depth: 1,
    status: 200,
    redirectTo: null,
    contentType: "text/html; charset=utf-8",
    canonical: `${SITE}${path}`,
    metaRobots: null,
    xRobotsTag: null,
    title: `Título ${path}`,
    h1: [`H1 ${path}`],
    internalLinks: [],
    ...over,
  };
}

test("crawl: un sitio sano no da hallazgos", () => {
  const rows = [crawl("/", { internalLinks: [`${SITE}/precios`, `${SITE}/blog`] }), crawl("/precios", { internalLinks: [`${SITE}/`] }), crawl("/blog", { internalLinks: [`${SITE}/`] })];
  assert.deepEqual(extractCrawlFindings(rows), []);
});

test("crawl: title vacío o igual al nombre del sitio, h1 múltiple, títulos repetidos", () => {
  const rows = [
    crawl("/", { internalLinks: [`${SITE}/a`, `${SITE}/b`, `${SITE}/c`] }),
    crawl("/a", { title: "miwebdeboda" }),
    crawl("/b", { title: "Igual", h1: ["uno", "dos"] }),
    crawl("/c", { title: "Igual" }),
  ];
  assert.deepEqual(types(extractCrawlFindings(rows)), ["h1-missing-or-multiple", "meta-duplicate", "meta-missing"]);
});

test("crawl: enlaces rotos y a redirecciones, huérfanas y URLs muertas del sitemap", () => {
  const rows = [
    crawl("/", { internalLinks: [`${SITE}/roto`, `${SITE}/viejo`] }),
    crawl("/roto", { status: 404, inSitemap: true }),
    crawl("/viejo", { status: 301, redirectTo: `${SITE}/nuevo`, inSitemap: false }),
    crawl("/huerfana"),
  ];
  assert.deepEqual(types(extractCrawlFindings(rows)), ["broken-internal-link", "link-to-redirect", "orphan-page", "sitemap-dead-url"]);
});

test("crawl: noindex en página comercial y páginas profundas", () => {
  const rows = [
    crawl("/", { internalLinks: [`${SITE}/plantillas/x`, `${SITE}/blog/hondo`] }),
    crawl("/plantillas/x", { metaRobots: "noindex, follow" }),
    crawl("/blog/hondo", { depth: 6 }),
  ];
  assert.deepEqual(types(extractCrawlFindings(rows)), ["deep-page", "noindex-commercial"]);
});

test("visibility-declining con base ≥ 100 y caída de más del 30%", () => {
  const prior = [{ page: "/a", type: "web", clicks: 5, impressions: 200 }, { page: "/b", type: "web", clicks: 1, impressions: 50 }];
  const recent = [{ page: "/a", type: "web", clicks: 2, impressions: 100 }, { page: "/b", type: "web", clicks: 0, impressions: 0 }];
  const out = extractVisibilityFindings(recent, prior);
  assert.deepEqual(out.map((f) => f.stableKeyInput), ["visibility-declining:/a"]);
});

test("image-opportunity: ≥ 200 impresiones de imagen y CTR < 1%", () => {
  const recent = [{ page: "/a", type: "image", clicks: 1, impressions: 300 }, { page: "/b", type: "image", clicks: 5, impressions: 300 }];
  assert.deepEqual(extractVisibilityFindings(recent, []).map((f) => f.stableKeyInput), ["image-opportunity:/a"]);
});

test("segment-declining solo si el total de la página aguanta", () => {
  const prior = [
    { page: "/a", device: "MOBILE", country: "esp", impressions: 200 },
    { page: "/a", device: "DESKTOP", country: "esp", impressions: 200 },
  ];
  const recent = [
    { page: "/a", device: "MOBILE", country: "esp", impressions: 50 },
    { page: "/a", device: "DESKTOP", country: "esp", impressions: 320 },
  ];
  assert.deepEqual(extractSegmentFindings(recent, prior).map((f) => f.stableKeyInput), ["segment-declining:/a:device:MOBILE"]);
  const allDown = recent.map((r) => ({ ...r, impressions: 10 }));
  assert.equal(extractSegmentFindings(allDown, prior).length, 0);
});

test("index-bloat: familia de ≥ 5 URLs con menos de 1 impresión por URL al mes", () => {
  const urls = ["madrid", "soria", "teruel", "cuenca", "avila"].map((p) => `${SITE}/fotografos-de-boda/${p}`);
  assert.equal(extractIndexBloatFindings(urls, new Map()).length, 1);
  assert.equal(extractIndexBloatFindings(urls, new Map(urls.map((u) => [u, 30]))).length, 0);
});

test("data-quality-gap: días finales que faltan", () => {
  const full = Array.from({ length: 12 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 10, 14) - (i + 1) * DAY),
    type: "web",
    dataset: "page",
    rowsReturned: 10,
    isFinal: true,
    pageTotalClicks: 20,
    queryDetailClicks: 16,
  }));
  assert.equal(extractDataQualityFindings(full, NOW).length, 0);
  const missing = full.filter((_, i) => i !== 5);
  assert.deepEqual(extractDataQualityFindings(missing, NOW).map((f) => f.stableKeyInput), ["data-quality-gap:web-page"]);
  const lowCoverage = full.map((r) => ({ ...r, queryDetailClicks: 1 }));
  assert.deepEqual(extractDataQualityFindings(lowCoverage, NOW).map((f) => f.stableKeyInput), ["data-quality-gap:query-coverage"]);
  const lowVolume = full.map((r) => ({ ...r, pageTotalClicks: 5, queryDetailClicks: 0 }));
  assert.equal(extractDataQualityFindings(lowVolume, NOW).length, 0);
  assert.equal(extractDataQualityFindings([], NOW).length, 0);
});

test("collector-failing: fallo o sin correr más de lo esperado", () => {
  const out = extractCollectorFindings(
    [
      { id: "1", workflowName: "daily-collection", lastRunAt: daysAgo(0.5), lastStatus: "ok" },
      { id: "2", workflowName: "daily-collection-b", lastRunAt: daysAgo(0.5), lastStatus: "failed" },
      { id: "3", workflowName: "weekly-sync", lastRunAt: daysAgo(6), lastStatus: "ok" },
      { id: "4", workflowName: "seo-tick", lastRunAt: daysAgo(3), lastStatus: "success" },
    ],
    NOW,
  );
  assert.deepEqual(out.map((f) => f.stableKeyInput).sort(), ["collector-failing:daily-collection-b", "collector-failing:seo-tick"]);
});

test("funnel-drop: cae una etapa con n ≥ 30 en las dos ventanas, solo canales de buscador", () => {
  const rows = [
    { date: daysAgo(60), channel: "google", registros: 100, bodasPublicadas: 50, pagos: 10 },
    { date: daysAgo(10), channel: "google", registros: 40, bodasPublicadas: 8, pagos: 2 },
    { date: daysAgo(10), channel: "instagram", registros: 500, bodasPublicadas: 400, pagos: 0 },
  ];
  assert.deepEqual(extractFunnelFindings(rows, NOW).map((f) => f.stableKeyInput), ["funnel-drop:registro → web publicada"]);
  const small = rows.map((r) => ({ ...r, registros: 10 }));
  assert.equal(extractFunnelFindings(small, NOW).length, 0);
});
