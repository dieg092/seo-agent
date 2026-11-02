// src/collectors/gscSitemapCollector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectGscSitemaps, parseCount } from "./gscSitemapCollector";
import { prisma } from "../db";

// Los tests usan sitemaps ficticios bajo este prefijo y solo borran esas filas.
const PREFIX = "https://miwebdeboda.com/test-sitemap-";

async function cleanup() {
  await prisma.gscSitemapStatus.deleteMany({ where: { path: { startsWith: PREFIX } } });
}

test("parseCount convierte cadenas int64 y trata lo ausente como 0", () => {
  assert.equal(parseCount("3"), 3);
  assert.equal(parseCount(7), 7);
  assert.equal(parseCount(undefined), 0);
  assert.equal(parseCount(null), 0);
  assert.equal(parseCount("abc"), 0);
});

test("guarda el estado de cada sitemap con errors y warnings como Int y el objeto en raw", async () => {
  await cleanup();
  try {
    const api = [
      {
        path: `${PREFIX}a.xml`,
        lastSubmitted: "2026-10-01T10:00:00.000Z",
        lastDownloaded: "2026-11-01T08:30:00.000Z",
        isPending: false,
        isSitemapsIndex: false,
        type: "sitemap",
        errors: "2",
        warnings: "5",
        contents: [{ type: "web", submitted: "120", indexed: "0" }],
      },
      { path: `${PREFIX}b.xml`, isPending: true },
    ];
    const now = new Date("2026-11-02T06:00:00.000Z");

    const result = await collectGscSitemaps({ list: async () => api, now });
    assert.equal(result.saved, 2);

    const rows = await prisma.gscSitemapStatus.findMany({
      where: { path: { startsWith: PREFIX } },
      orderBy: { path: "asc" },
    });
    assert.equal(rows.length, 2);

    const [a, b] = rows;
    assert.equal(a.errors, 2);
    assert.equal(a.warnings, 5);
    assert.equal(a.isPending, false);
    assert.equal(a.checkedAt.toISOString(), now.toISOString());
    assert.equal(a.lastSubmitted?.toISOString(), "2026-10-01T10:00:00.000Z");
    assert.equal(a.lastDownloaded?.toISOString(), "2026-11-01T08:30:00.000Z");
    assert.deepEqual(a.raw, api[0]);
    assert.deepEqual(a.contents, api[0].contents);

    assert.equal(b.errors, 0);
    assert.equal(b.warnings, 0);
    assert.equal(b.isPending, true);
    assert.equal(b.lastSubmitted, null);
    assert.equal(b.lastDownloaded, null);
    assert.deepEqual(b.raw, api[1]);
  } finally {
    await cleanup();
  }
});

test("cada ejecucion añade una foto nueva para conservar el historico", async () => {
  await cleanup();
  try {
    const list = async () => [{ path: `${PREFIX}c.xml`, isPending: true, errors: "0", warnings: "0" }];
    await collectGscSitemaps({ list, now: new Date("2026-11-01T06:00:00.000Z") });
    await collectGscSitemaps({ list, now: new Date("2026-11-02T06:00:00.000Z") });

    const count = await prisma.gscSitemapStatus.count({ where: { path: `${PREFIX}c.xml` } });
    assert.equal(count, 2);
  } finally {
    await cleanup();
  }
});

test("ignora entradas sin path", async () => {
  await cleanup();
  try {
    const result = await collectGscSitemaps({
      list: async () => [{ isPending: false }, { path: `${PREFIX}d.xml`, errors: "1" }],
    });
    assert.equal(result.saved, 1);
  } finally {
    await cleanup();
  }
});
