import { test } from "node:test";
import assert from "node:assert/strict";
import { getPublishedArticleUrls, fetchArticleText } from "./fetchArticleContent";

const SAMPLE_SITEMAP = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://miwebdeboda.com</loc></url>
  <url><loc>https://miwebdeboda.com/blog/invitaciones/como-elegir-invitaciones</loc></url>
  <url><loc>https://miwebdeboda.com/blog/presupuesto/cuanto-cuesta-una-boda</loc></url>
  <url><loc>https://miwebdeboda.com/glosario-bodas</loc></url>
</urlset>`;

test("getPublishedArticleUrls extracts only /blog/ URLs with their slug", async () => {
  const result = await getPublishedArticleUrls({
    fetchXml: async () => SAMPLE_SITEMAP,
    baseUrl: "https://miwebdeboda.com",
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].slug, "invitaciones/como-elegir-invitaciones");
  assert.equal(result[0].url, "https://miwebdeboda.com/blog/invitaciones/como-elegir-invitaciones");
  assert.equal(result[1].slug, "presupuesto/cuanto-cuesta-una-boda");
});

test("getPublishedArticleUrls returns an empty array when there are no blog URLs", async () => {
  const result = await getPublishedArticleUrls({
    fetchXml: async () => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://miwebdeboda.com</loc></url></urlset>`,
    baseUrl: "https://miwebdeboda.com",
  });

  assert.deepEqual(result, []);
});

const SAMPLE_ARTICLE_HTML = `<html><body>
<nav>Menú de navegación irrelevante</nav>
<article>
  <h1>Cómo elegir invitaciones de boda</h1>
  <p>Las invitaciones son el primer contacto de tus invitados con la boda.</p>
  <p>Elige un papel de calidad y un diseño coherente con el resto de la papelería.</p>
</article>
<footer>Pie de página irrelevante</footer>
</body></html>`;

test("fetchArticleText extracts only the article's own text, not nav/footer", async () => {
  const text = await fetchArticleText({
    url: "https://miwebdeboda.com/blog/invitaciones/como-elegir-invitaciones",
    fetchHtml: async () => SAMPLE_ARTICLE_HTML,
  });

  assert.ok(text.includes("Cómo elegir invitaciones de boda"));
  assert.ok(text.includes("papel de calidad"));
  assert.ok(!text.includes("Menú de navegación"));
  assert.ok(!text.includes("Pie de página"));
});

// Mirrors the REAL production template (no <article> tag anywhere): an outer
// page-layout <main> containing the sitewide nav <header>, an INNER bare
// <main> scoped to just this page's content (whose own title lives in a
// generic <header class="mb-12">), and a sitewide <footer>.
const SAMPLE_NESTED_MAIN_HTML = `<html><body>
<main class="flex-1 flex flex-col min-h-0">
  <header class="relative z-50">Menú de navegación sitewide</header>
  <main>
    <header class="mb-12">
      <p>Organizar la boda</p>
      <h1>Cómo gestionar los alérgenos y menús especiales en tu boda</h1>
      <div>29 de junio de 2026 · 7 min de lectura</div>
    </header>
    <figure>Foto ilustrativa</figure>
    <div class="prose-article">
      <p>Habéis enviado las invitaciones y ya han empezado a llegar las respuestas.</p>
    </div>
  </main>
  <footer class="border-t">Pie de página sitewide</footer>
</main>
</body></html>`;

test("fetchArticleText extracts the article's own title from a nested <main> structure with no <article> tag (real production shape)", async () => {
  const text = await fetchArticleText({
    url: "https://miwebdeboda.com/blog/organizar-boda/gestionar-alergias-boda",
    fetchHtml: async () => SAMPLE_NESTED_MAIN_HTML,
  });

  assert.ok(text.includes("Cómo gestionar los alérgenos y menús especiales en tu boda"));
  assert.ok(text.includes("Habéis enviado las invitaciones"));
  assert.ok(!text.includes("Menú de navegación sitewide"));
  assert.ok(!text.includes("Pie de página sitewide"));
});
