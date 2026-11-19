// src/bridge/semanticScope.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { semanticScope, routeOfPage, diffHunks } from "./semanticScope";

const POSTS = `export const posts = [
  {
    slug: "save-the-date-navidad-digital",
    title: "Cómo crear un save the date digital para Navidad",
    metaDescription:
      "Texto viejo.",
    excerpt: "Resumen.",
    updatedAt: "2026-08-05",
  },
  {
    slug: "otro-post",
    title: "Otro",
    metaDescription: "Otro texto.",
    updatedAt: "2026-08-05",
  },
];
`;
const URL_STD = "https://miwebdeboda.com/blog/invitaciones-y-web-de-boda/save-the-date-navidad-digital";

test("diffHunks da los trozos cambiados", () => {
  const h = diffHunks("a\nb\nc\n", "a\nB\nc\n");
  assert.deepEqual(h, [{ removed: ["b"], added: ["B"], headStart: 2 }]);
});

test("meta: title y description del post del contrato pasan; otro post, el excerpt o un fichero nuevo no", () => {
  const ok = POSTS.replace("Texto viejo.", "Texto nuevo y mejor.").replace(
    '    title: "Cómo crear',
    '    // cambiado por CTR bajo\n    seoTitle: "Save the date digital para Navidad",\n    title: "Cómo crear',
  );
  assert.deepEqual(semanticScope("meta-title-description", [{ path: "src/lib/blog/posts.ts", base: POSTS, head: ok }], [URL_STD]), { ok: true });

  const otro = POSTS.replace("Otro texto.", "Otro texto cambiado.");
  const r1 = semanticScope("meta-title-description", [{ path: "src/lib/blog/posts.ts", base: POSTS, head: otro }], [URL_STD]);
  assert.equal(r1.ok, false);
  assert.match((r1 as { reason: string }).reason, /otro-post/);

  const excerpt = POSTS.replace("Resumen.", "Resumen cambiado.");
  assert.match((semanticScope("meta-title-description", [{ path: "src/lib/blog/posts.ts", base: POSTS, head: excerpt }], [URL_STD]) as { reason: string }).reason, /no es title ni description/);
  assert.equal(semanticScope("meta-title-description", [{ path: "src/app/x/page.tsx", base: null, head: "x" }], [URL_STD]).ok, false);
});

test("meta en page.tsx: solo la página de la URL del contrato", () => {
  const base = 'export const metadata = {\n  title: "Canario SEO | miwebdeboda.com",\n  description: "Viejo.",\n  robots: { index: false },\n};\n';
  const head = base.replace("Canario SEO |", "Canario SEO 2026-11-19 |").replace("Viejo.", "Nuevo.");
  const f = [{ path: "src/app/seo-canario/page.tsx", base, head }];
  assert.deepEqual(semanticScope("meta-title-description", f, ["https://miwebdeboda.com/seo-canario"]), { ok: true });
  assert.equal(semanticScope("meta-title-description", f, ["https://miwebdeboda.com/precios"]).ok, false);
  const robots = head.replace("index: false", "index: true");
  assert.match((semanticScope("meta-title-description", [{ path: "src/app/seo-canario/page.tsx", base, head: robots }], ["https://miwebdeboda.com/seo-canario"]) as { reason: string }).reason, /robots/);
  assert.equal(routeOfPage("src/app/(marketing)/precios/page.tsx"), "/precios");
  assert.equal(routeOfPage("src/app/page.tsx"), "/");
  assert.equal(routeOfPage("src/app/[slug]/page.tsx"), null);
});

test("enlace roto: solo cambia el destino, y el nuevo es público", () => {
  const base = 'Lee [la guía](/blog/organizar-boda/vieja) y <a href="/precios">precios</a>.\nOtra línea.\n';
  const ok = base.replace("/blog/organizar-boda/vieja", "/blog/organizar-boda/nueva");
  assert.deepEqual(semanticScope("broken-internal-link-fix", [{ path: "src/lib/blog/content/a/b.ts", base, head: ok }], []), { ok: true });
  const texto = base.replace("la guía", "la guía completa").replace("/vieja", "/nueva");
  assert.match((semanticScope("broken-internal-link-fix", [{ path: "src/lib/blog/content/a/b.ts", base, head: texto }], []) as { reason: string }).reason, /texto además/);
  const privado = base.replace("/blog/organizar-boda/vieja", "/canario-privado-7f3a");
  assert.match((semanticScope("broken-internal-link-fix", [{ path: "src/lib/blog/content/a/b.ts", base, head: privado }], []) as { reason: string }).reason, /no es una página pública/);
  const extra = base + "Línea nueva.\n";
  assert.equal(semanticScope("broken-internal-link-fix", [{ path: "src/lib/blog/content/a/b.ts", base, head: extra }], []).ok, false);
});

test("mejorar artículo: solo el texto del artículo y la fecha en posts.ts", () => {
  const base = "import x from './x';\n\nconst content = `## Hola\\n\\nTexto \\`viejo\\`.`;\n\nexport default content;\n";
  const head = base.replace("Texto \\`viejo\\`.", "Texto mejor, con \\`código\\` y más.");
  const posts = POSTS.replace('updatedAt: "2026-08-05",\n  },\n  {\n    slug: "otro', 'updatedAt: "2026-11-19",\n  },\n  {\n    slug: "otro');
  assert.deepEqual(
    semanticScope("content-improve", [{ path: "src/lib/blog/content/a/b.ts", base, head }, { path: "src/lib/blog/posts.ts", base: POSTS, head: posts }], []),
    { ok: true },
  );
  const fuera = head.replace("export default content;", "export default content;\nexport const otra = 1;");
  assert.match((semanticScope("content-improve", [{ path: "src/lib/blog/content/a/b.ts", base, head: fuera }], []) as { reason: string }).reason, /fuera del texto/);
  const titulo = POSTS.replace('title: "Otro"', 'title: "Otro cambiado"');
  assert.match((semanticScope("content-improve", [{ path: "src/lib/blog/posts.ts", base: POSTS, head: titulo }], []) as { reason: string }).reason, /fecha/);
});

test("operaciones sin regla propia: no hay fusión automática", () => {
  assert.equal(semanticScope("jsonld-fix", [{ path: "a", base: "a", head: "b" }], []).ok, false);
});
