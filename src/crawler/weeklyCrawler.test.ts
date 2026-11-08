// src/crawler/weeklyCrawler.test.ts
// El rastreador se prueba contra un servidor HTTP local: nunca contra producción.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { prisma } from "../db";
import { hmac12 } from "../privacy/redact";
import { crawlSite, CRAWL_USER_AGENT } from "./weeklyCrawler";

// Clave ficticia, solo para tests.
const KEY = "clave-ficticia-de-test-rastreo";
process.env.SEO_PRIVATE_URL_KEY = KEY;

// Las filas se guardan con runAt en 2002: los tests solo borran ese rango.
const RUN_AT = new Date("2002-03-04T05:00:00Z");
const RUN_RANGE = { gte: new Date("2002-01-01"), lte: new Date("2002-12-31") };
const SITE = "https://miwebdeboda.com";

async function cleanup() {
  await prisma.crawlPage.deleteMany({ where: { runAt: RUN_RANGE } });
}

after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

function html(head: string, body: string): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

type Route = { status: number; headers?: Record<string, string>; body?: string };

function site(): Record<string, Route> {
  const page = (head: string, body: string): Route => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: html(head, body),
  });
  const xml = (body: string): Route => ({ status: 200, headers: { "content-type": "application/xml" }, body });
  return {
    "/robots.txt": {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: `User-agent: *\nDisallow: /precios/bloqueada\nSitemap: ${SITE}/sitemap.xml\n`,
    },
    // Índice que apunta a miwebdeboda.com: el rastreador lo pide a la base local.
    "/sitemap.xml": xml(
      `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${SITE}/sitemap-paginas.xml</loc></sitemap></sitemapindex>`
    ),
    "/sitemap-paginas.xml": xml(
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        [`${SITE}/`, `${SITE}/blog`, `${SITE}/precios/bloqueada`, `${SITE}/pareja-ficticia`]
          .map((u) => `<url><loc>${u}</loc></url>`)
          .join("") +
        `</urlset>`
    ),
    "/": page(
      `<title> Inicio  de prueba </title><link rel="canonical" href="${SITE}/"><meta name="robots" content="index, follow">`,
      `<h1>Hola</h1><h1> Otra  cabecera </h1><img src="/portada.jpg">` +
        `<a href="/blog">blog</a><a href="/blog/articulo-uno#seccion">uno</a>` +
        `<a href="/pareja-ficticia">pareja</a><a href="/pareja-ficticia/i/token-ficticio">invitación</a>` +
        `<a href="/login">entrar</a><a href="https://externa.example/x">fuera</a>` +
        `<a href="/blog/foto.jpg">foto</a><a href="mailto:nadie@example.com">correo</a><a href="#arriba">arriba</a>`
    ),
    "/blog": page(
      `<title>Blog</title><link rel="canonical" href="/blog">`,
      `<h1>Blog</h1><a href="/blog/articulo-uno">uno</a><a href="/blog/no-existe">roto</a>` +
        `<a href="/blog/viejo">viejo</a><a href="/blog/redir-privada">otra</a>`
    ),
    "/blog/articulo-uno": page(
      // Canónica privada por error: se guarda redactada.
      `<title>Artículo uno</title><link rel="canonical" href="/pareja-ficticia"><meta name="robots" content="noindex">`,
      `<h1>Uno</h1><img src="/blog/imagen.webp"><a href="/">inicio</a>`
    ),
    "/blog/viejo": { status: 301, headers: { location: "/blog/articulo-dos" } },
    "/blog/redir-privada": { status: 302, headers: { location: "/pareja-ficticia" } },
    "/blog/articulo-dos": page(`<title>Dos</title>`, `<h1>Dos</h1>`),
    "/feed.xml": xml("<rss></rss>"),
  };
}

interface TestServer {
  baseUrl: string;
  requested: string[];
  userAgents: Set<string>;
  maxInFlight: () => number;
  close: () => Promise<void>;
}

async function startServer(routes: Record<string, Route>, delayMs = 0): Promise<TestServer> {
  const requested: string[] = [];
  const userAgents = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    requested.push(path);
    userAgents.add(String(req.headers["user-agent"] ?? ""));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const route = routes[path] ?? { status: 404, headers: { "content-type": "text/html" }, body: html("", "no existe") };
    res.writeHead(route.status, route.headers ?? {});
    res.end(route.body ?? "");
    inFlight -= 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requested,
    userAgents,
    maxInFlight: () => maxInFlight,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("rastrea el sitemap y los enlaces públicos, sin abrir privadas ni imágenes", async () => {
  await cleanup();
  const srv = await startServer(site());
  try {
    const result = await crawlSite({ baseUrl: srv.baseUrl, delayMs: 0, now: RUN_AT });
    const byUrl = new Map(result.pages.map((p) => [p.url, p]));

    // Nunca se piden webs de parejas, invitaciones, rutas con sesión ni imágenes.
    for (const forbidden of ["/pareja-ficticia", "/pareja-ficticia/i/token-ficticio", "/login", "/portada.jpg", "/blog/foto.jpg", "/blog/imagen.webp"]) {
      assert.equal(srv.requested.includes(forbidden), false, `no debía pedir ${forbidden}`);
    }
    // robots.txt manda: la ruta prohibida no se pide, pero queda la fila.
    assert.equal(srv.requested.includes("/precios/bloqueada"), false);
    assert.equal(byUrl.get(`${SITE}/precios/bloqueada`)?.blockedByRobots, true);
    // Todo se pide a la base local, con nuestro user-agent.
    assert.deepEqual([...srv.userAgents], [CRAWL_USER_AGENT]);
    assert.ok(srv.requested.includes("/sitemap-paginas.xml"));

    // Ninguna fila es de una ruta privada.
    assert.equal([...byUrl.keys()].some((u) => u.includes("pareja-ficticia") || u.includes("/login")), false);
    assert.deepEqual(
      [...byUrl.keys()].sort(),
      [
        `${SITE}/`,
        `${SITE}/blog`,
        `${SITE}/blog/articulo-dos`,
        `${SITE}/blog/articulo-uno`,
        `${SITE}/blog/no-existe`,
        `${SITE}/blog/redir-privada`,
        `${SITE}/blog/viejo`,
        `${SITE}/precios/bloqueada`,
      ]
    );

    const home = byUrl.get(`${SITE}/`)!;
    assert.equal(home.status, 200);
    assert.equal(home.inSitemap, true);
    assert.equal(home.depth, 0);
    assert.equal(home.title, "Inicio de prueba");
    assert.deepEqual(home.h1, ["Hola", "Otra cabecera"]);
    assert.equal(home.canonical, `${SITE}/`);
    assert.equal(home.metaRobots, "index, follow");
    assert.ok((home.bytes ?? 0) > 100);
    assert.deepEqual(home.internalLinks.sort(), [`${SITE}/blog`, `${SITE}/blog/articulo-uno`]);
    // /pareja-ficticia, su invitación y /login se cuentan pero no se guardan.
    assert.equal(home.privateLinkCount, 3);

    const blog = byUrl.get(`${SITE}/blog`)!;
    assert.equal(blog.canonical, `${SITE}/blog`);
    assert.equal(byUrl.get(`${SITE}/blog/no-existe`)?.status, 404);
    assert.equal(byUrl.get(`${SITE}/blog/no-existe`)?.inSitemap, false);
    assert.equal(byUrl.get(`${SITE}/blog/no-existe`)?.depth, 1);

    // Las redirecciones no se siguen solas: la pública se encola, la privada se redacta.
    const viejo = byUrl.get(`${SITE}/blog/viejo`)!;
    assert.equal(viejo.status, 301);
    assert.equal(viejo.redirectTo, `${SITE}/blog/articulo-dos`);
    assert.equal(byUrl.get(`${SITE}/blog/articulo-dos`)?.status, 200);
    const redirPrivada = byUrl.get(`${SITE}/blog/redir-privada`)!;
    assert.equal(redirPrivada.status, 302);
    assert.equal(redirPrivada.redirectTo, `${SITE}/<privada:${hmac12(`${SITE}/pareja-ficticia`, KEY)}>`);

    const uno = byUrl.get(`${SITE}/blog/articulo-uno`)!;
    assert.equal(uno.canonical, `${SITE}/<privada:${hmac12(`${SITE}/pareja-ficticia`, KEY)}>`);
    assert.equal(uno.metaRobots, "noindex");

    assert.ok(result.skippedPrivate >= 4);
    assert.ok(result.skippedAssets >= 1);

    // Se guarda en la BD, una fila por URL.
    const rows = await prisma.crawlPage.findMany({ where: { runAt: RUN_AT } });
    assert.equal(rows.length, result.pages.length);
    const stored = rows.find((r) => r.url === `${SITE}/`)!;
    assert.deepEqual(stored.h1, ["Hola", "Otra cabecera"]);
    assert.equal(stored.privateLinkCount, 3);
    assert.equal(rows.some((r) => JSON.stringify(r).includes("pareja-ficticia")), false);
  } finally {
    await srv.close();
    await cleanup();
  }
});

test("respeta el límite de páginas y la concurrencia", async () => {
  const srv = await startServer(site(), 30);
  try {
    const result = await crawlSite({ baseUrl: srv.baseUrl, delayMs: 0, maxPages: 2, concurrency: 2, persist: false });
    assert.equal(result.pages.length, 2);
    assert.ok(result.skippedByLimit > 0);
    assert.ok(srv.maxInFlight() <= 2);
  } finally {
    await srv.close();
  }
});

test("respeta la profundidad máxima", async () => {
  const srv = await startServer(site());
  try {
    const result = await crawlSite({ baseUrl: srv.baseUrl, delayMs: 0, maxDepth: 0, persist: false });
    assert.deepEqual(result.pages.map((p) => p.url).sort(), [`${SITE}/`, `${SITE}/blog`, `${SITE}/precios/bloqueada`]);
    assert.ok(result.skippedByLimit > 0);
  } finally {
    await srv.close();
  }
});

test("si robots.txt falla con 5xx no se rastrea nada", async () => {
  const routes = site();
  routes["/robots.txt"] = { status: 503, body: "" };
  const srv = await startServer(routes);
  try {
    await assert.rejects(crawlSite({ baseUrl: srv.baseUrl, delayMs: 0, persist: false }), /robots\.txt respondió 503/);
    assert.deepEqual(srv.requested, ["/robots.txt"]);
  } finally {
    await srv.close();
  }
});

test("sin robots.txt (404) se rastrea todo lo público", async () => {
  const routes = site();
  delete routes["/robots.txt"];
  const srv = await startServer(routes);
  try {
    const result = await crawlSite({ baseUrl: srv.baseUrl, delayMs: 0, persist: false });
    assert.equal(result.pages.find((p) => p.url === `${SITE}/precios/bloqueada`)?.status, 404);
  } finally {
    await srv.close();
  }
});

test("sin SEO_PRIVATE_URL_KEY no rastrea", async () => {
  const saved = process.env.SEO_PRIVATE_URL_KEY;
  delete process.env.SEO_PRIVATE_URL_KEY;
  try {
    await assert.rejects(crawlSite({ baseUrl: "http://127.0.0.1:9", persist: false }), /SEO_PRIVATE_URL_KEY/);
  } finally {
    process.env.SEO_PRIVATE_URL_KEY = saved;
  }
});
