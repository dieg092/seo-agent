// src/bridge/scopeCheck.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkScope, globToRegExp, parseNumstat } from "./scopeCheck";

test("globToRegExp: * no cruza carpetas y ** sí", () => {
  assert.ok(globToRegExp("src/app/**/page.tsx").test("src/app/page.tsx"));
  assert.ok(globToRegExp("src/app/**/page.tsx").test("src/app/precios/page.tsx"));
  assert.ok(globToRegExp("src/app/**/page.tsx").test("src/app/blog/[slug]/page.tsx"));
  assert.ok(!globToRegExp("src/app/**/page.tsx").test("src/app/precios/layout.tsx"));
  assert.ok(globToRegExp("src/lib/blog/content/**").test("src/lib/blog/content/a/b.mdx"));
  assert.ok(!globToRegExp("src/lib/*.ts").test("src/lib/seo/x.ts"));
  assert.ok(!globToRegExp("src/app/sitemap.ts").test("src/app/sitemapXts"));
});

test("parseNumstat lee líneas y binarios", () => {
  assert.deepEqual(parseNumstat("3\t1\tsrc/app/sitemap.ts\n-\t-\tpublic/x.png\n"), [
    { path: "src/app/sitemap.ts", added: 3, deleted: 1 },
    { path: "public/x.png", added: 1, deleted: 1 },
  ]);
});

test("checkScope acepta un cambio dentro del alcance", () => {
  const r = checkScope("meta-title-description", [{ path: "src/app/precios/page.tsx", added: 2, deleted: 2 }]);
  assert.deepEqual(r, { ok: true, errors: [] });
});

test("checkScope rechaza rutas fuera, límites, operaciones desconocidas y PRs vacíos", () => {
  const out = checkScope("meta-title-description", [
    { path: "src/app/precios/page.tsx", added: 2, deleted: 0 },
    { path: ".github/workflows/ci.yml", added: 1, deleted: 0 },
  ]);
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.includes(".github/workflows/ci.yml")));

  const big = checkScope("robots-restore-sitemap-directive", [{ path: "src/app/robots.ts", added: 6, deleted: 0 }]);
  assert.ok(big.errors.some((e) => e.includes("líneas")));

  const many = checkScope("sitemap-drop-dead-url", [
    { path: "src/app/sitemap.ts", added: 1, deleted: 0 },
    { path: "src/app/sitemap.ts", added: 1, deleted: 0 },
  ]);
  assert.ok(many.errors.some((e) => e.includes("ficheros")));

  assert.equal(checkScope("rm-rf", [{ path: "x", added: 1, deleted: 0 }]).ok, false);
  assert.equal(checkScope("proposal", [{ path: "src/app/page.tsx", added: 1, deleted: 0 }]).ok, false);
  assert.ok(checkScope("robots-restore-sitemap-directive", []).errors.includes("el PR no cambia nada"));
  assert.equal(checkScope("meta-title-description", [{ path: "src/app/a.tsx => src/app/precios/page.tsx", added: 0, deleted: 0 }]).ok, false);
});
