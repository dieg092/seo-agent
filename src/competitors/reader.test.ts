// src/competitors/reader.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_ALL, parseRobotsTxt } from "../crawler/robotsTxt";
import { COMPETITOR_USER_AGENT, MONTHLY_PAGE_BUDGET, PAGES_PER_RUN, REQUEST_DELAY_MS, extractStructure, parseSitemap, pickPages, readCompetitor, robotsSitemaps, type FetchResult } from "./reader";

test("sitemaps de robots.txt e índices", () => {
  assert.deepEqual(robotsSitemaps("User-agent: *\nDisallow: /x\nSitemap: https://www.a.com/s1.xml\nsitemap:https://www.a.com/s2.xml"), ["https://www.a.com/s1.xml", "https://www.a.com/s2.xml"]);
  const idx = parseSitemap("<sitemapindex><sitemap><loc>https://www.a.com/p.xml</loc></sitemap></sitemapindex>");
  assert.deepEqual(idx, { pages: [], sitemaps: ["https://www.a.com/p.xml"] });
  const set = parseSitemap("<urlset><url><loc> https://www.a.com/a?x=1&amp;y=2 </loc><lastmod>2026</lastmod></url><url><loc>https://www.a.com/b</loc></url></urlset>");
  assert.deepEqual(set.pages, ["https://www.a.com/a?x=1&y=2", "https://www.a.com/b"]);
  assert.deepEqual(parseSitemap("<urlset><url><loc><![CDATA[https://www.a.com/c]]></loc></url></urlset>").pages, ["https://www.a.com/c"]);
});

test("estructura sin texto: title, h1, h2/h3, schema, palabras, idioma, noindex", () => {
  const html = `<!doctype html><html lang="es"><head><title>Web de boda &amp; más</title>
    <meta name="robots" content="noindex,follow">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebPage","FAQPage"]}]}</script>
    <script type="application/ld+json">{roto</script></head>
    <body><h1>Crea tu <b>web</b></h1><h2>Precios</h2><h3>Plan gratis</h3><p>uno dos tres 2026</p><script>var no = "cuenta";</script></body></html>`;
  const s = extractStructure(html);
  assert.equal(s.title, "Web de boda & más");
  assert.equal(s.h1, "Crea tu web");
  assert.deepEqual(s.headings, ["Precios", "Plan gratis"]);
  assert.deepEqual(s.jsonLdTypes, ["FAQPage", "Organization", "WebPage"]);
  assert.equal(s.lang, "es");
  assert.equal(s.noindex, true);
  assert.equal(s.wordCount, 9, "Crea tu web Precios Plan gratis uno dos tres; sin números ni scripts");
});

test("pickPages: mismo dominio, robots, sin repetidas, menos profundas primero, con cupo", () => {
  const policy = parseRobotsTxt("User-agent: *\nDisallow: /privado", COMPETITOR_USER_AGENT);
  const got = pickPages(
    ["https://www.a.com/x/y/z", "https://www.a.com/precios", "https://www.a.com/privado/1", "https://otro.com/p", "https://www.a.com/precios#h", "https://blog.a.com/p", "ftp://a.com/f", "https://www.a.com/ya"],
    "a.com",
    new Set(["https://www.a.com/ya"]),
    policy,
    3,
  );
  assert.deepEqual(got, ["https://blog.a.com/p", "https://www.a.com/precios", "https://www.a.com/x/y/z"]);
  assert.deepEqual(pickPages(["https://www.a.com/p"], "a.com", new Set(), ALLOW_ALL, 0), []);
  const list = Array.from({ length: 20 }, (_, i) => `https://www.a.com/s/p${String(i).padStart(2, "0")}`);
  assert.deepEqual(pickPages(list, "a.com", new Set(), ALLOW_ALL, 4).map((u) => u.slice(-3)), ["p00", "p01", "p02", "p11"], "mitad al principio, mitad repartida");
});

function fakeSite(routes: Record<string, FetchResult | Error>) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    fetcher: async (url: string) => {
      calls.push(url);
      const r = routes[url];
      if (!r) return { status: 404, text: "", contentType: "text/html" };
      if (r instanceof Error) throw r;
      return r;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}
const xml = (s: string): FetchResult => ({ status: 200, text: s, contentType: "application/xml" });
const page = (h1: string): FetchResult => ({ status: 200, text: `<html><head><title>${h1} | A</title></head><body><h1>${h1}</h1></body></html>`, contentType: "text/html; charset=utf-8" });

test("una pasada: robots, sitemap índice, páginas permitidas y 5 s entre peticiones", async () => {
  const site = fakeSite({
    "https://www.a.com/robots.txt": { status: 200, text: "User-agent: *\nDisallow: /cuenta\nSitemap: https://www.a.com/index.xml", contentType: "text/plain" },
    "https://www.a.com/index.xml": xml("<sitemapindex><sitemap><loc>https://www.a.com/images.xml</loc></sitemap><sitemap><loc>https://www.a.com/pages.xml</loc></sitemap></sitemapindex>"),
    "https://www.a.com/pages.xml": xml("<urlset><url><loc>https://www.a.com/precios</loc></url><url><loc>https://www.a.com/cuenta/login</loc></url></urlset>"),
    "https://www.a.com/precios": page("Precios"),
  });
  const r = await readCompetitor("a.com", { fetcher: site.fetcher, sleep: site.sleep, fetchedThisMonth: 0, recentlyFetched: new Set() });
  assert.deepEqual(r.pages.map((p) => [p.path, p.h1]), [["/precios", "Precios"]]);
  assert.ok(!site.calls.includes("https://www.a.com/cuenta/login"), "robots.txt prohíbe /cuenta");
  assert.equal(site.calls[0], "https://www.a.com/robots.txt");
  assert.ok(!site.calls.includes("https://www.a.com/images.xml"), "los sitemaps de imágenes no se leen");
  assert.equal(site.sleeps.length, site.calls.length - 1);
  assert.ok(site.sleeps.every((ms) => ms === REQUEST_DELAY_MS));
});

test("cupos y robots que no responde", async () => {
  const spent = fakeSite({});
  assert.deepEqual((await readCompetitor("a.com", { ...spent, fetchedThisMonth: MONTHLY_PAGE_BUDGET, recentlyFetched: new Set() })).pages, []);
  assert.equal(spent.calls.length, 0, "sin cupo no se pide nada");

  const down = fakeSite({ "https://www.a.com/robots.txt": { status: 503, text: "", contentType: "text/plain" } });
  const r = await readCompetitor("a.com", { ...down, fetchedThisMonth: 0, recentlyFetched: new Set() });
  assert.equal(r.pages.length, 0);
  assert.deepEqual(down.calls, ["https://www.a.com/robots.txt"], "con robots.txt en 5xx no se rastrea");

  const urls = Array.from({ length: 40 }, (_, i) => `<url><loc>https://www.a.com/p${String(i).padStart(2, "0")}</loc></url>`).join("");
  const routes: Record<string, FetchResult> = { "https://www.a.com/sitemap.xml": xml(`<urlset>${urls}</urlset>`) };
  for (let i = 0; i < 40; i++) routes[`https://www.a.com/p${String(i).padStart(2, "0")}`] = page(`P${i}`);
  const many = fakeSite(routes);
  const r2 = await readCompetitor("a.com", { ...many, fetchedThisMonth: MONTHLY_PAGE_BUDGET - 3, recentlyFetched: new Set() });
  assert.equal(r2.pages.length, 3, "lo que queda del cupo mensual");
  const r3 = await readCompetitor("a.com", { ...fakeSite(routes), fetchedThisMonth: 0, recentlyFetched: new Set() });
  assert.equal(r3.pages.length, PAGES_PER_RUN);
});

test("índices anidados: baja en profundidad; robots 403 no se rastrea", async () => {
  const site = fakeSite({
    "https://www.a.com/robots.txt": { status: 200, text: "Sitemap: https://www.a.com/photo-index.xml\nSitemap: https://www.a.com/i1.xml\nSitemap: https://www.a.com/i2.xml\nSitemap: https://www.a.com/i3.xml", contentType: "text/plain" },
    "https://www.a.com/i1.xml": xml("<sitemapindex><sitemap><loc>https://www.a.com/i1-a.xml</loc></sitemap></sitemapindex>"),
    "https://www.a.com/i1-a.xml": xml("<sitemapindex><sitemap><loc>https://www.a.com/leaf.xml</loc></sitemap></sitemapindex>"),
    "https://www.a.com/leaf.xml": xml("<urlset><url><loc>https://www.a.com/p</loc></url></urlset>"),
    "https://www.a.com/p": page("P"),
  });
  const r = await readCompetitor("a.com", { ...site, fetchedThisMonth: 0, recentlyFetched: new Set() });
  assert.deepEqual(r.pages.map((p) => p.path), ["/p"]);
  assert.ok(!site.calls.includes("https://www.a.com/photo-index.xml"));

  const blocked = fakeSite({ "https://www.a.com/robots.txt": { status: 403, text: "", contentType: "text/html" } });
  assert.equal((await readCompetitor("a.com", { ...blocked, fetchedThisMonth: 0, recentlyFetched: new Set() })).pages.length, 0);
  assert.equal(blocked.calls.length, 1);
});

test("un 429 para la pasada del dominio", async () => {
  const site = fakeSite({
    "https://www.a.com/sitemap.xml": xml("<urlset><url><loc>https://www.a.com/a</loc></url><url><loc>https://www.a.com/b</loc></url></urlset>"),
    "https://www.a.com/a": { status: 429, text: "", contentType: "text/html" },
    "https://www.a.com/b": page("B"),
  });
  const r = await readCompetitor("a.com", { ...site, fetchedThisMonth: 0, recentlyFetched: new Set() });
  assert.equal(r.pages.length, 1);
  assert.ok(!site.calls.includes("https://www.a.com/b"));
});
