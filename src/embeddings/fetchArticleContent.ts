import * as cheerio from "cheerio";
import { getEnv } from "../env";

export async function getPublishedArticleUrls(deps: {
  fetchXml?: (url: string) => Promise<string>;
  baseUrl?: string;
} = {}): Promise<{ slug: string; url: string }[]> {
  const baseUrl = deps.baseUrl ?? getEnv("SITE_BASE_URL");
  const fetchXml =
    deps.fetchXml ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Sitemap fetch failed: ${response.status}`);
      return response.text();
    });

  const xml = await fetchXml(`${baseUrl}/sitemap.xml`);
  const $ = cheerio.load(xml, { xmlMode: true });

  const results: { slug: string; url: string }[] = [];
  const blogPrefix = `${baseUrl}/blog/`;

  $("url > loc").each((_, el) => {
    const url = $(el).text().trim();
    if (url.startsWith(blogPrefix)) {
      const slug = url.slice(blogPrefix.length);
      results.push({ slug, url });
    }
  });

  return results;
}

export async function fetchArticleText(deps: {
  url: string;
  fetchHtml?: (url: string) => Promise<string>;
}): Promise<string> {
  const fetchHtml =
    deps.fetchHtml ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      return response.text();
    });

  const html = await fetchHtml(deps.url);
  const $ = cheerio.load(html);

  // Prefer a genuine <article> tag if a template ever provides one — it is
  // assumed to already be scoped to just this page's content, so no tag
  // stripping is needed (or correct: stripping `header` here would remove
  // the article's own title if it's wrapped in one).
  const article = $("article").first();
  if (article.length > 0) {
    return article.text().replace(/\s+/g, " ").trim();
  }

  // The real production template has no <article> tag: it nests a bare
  // <main> (scoped to just this page's content, including its own
  // <header class="mb-12"> title block) inside an outer page-layout <main>
  // that also holds the sitewide nav header and footer. `main main` selects
  // only the inner one via cheerio's descendant combinator. Since this is
  // already correctly scoped, no further stripping is needed or correct.
  const innerMain = $("main main").first();
  if (innerMain.length > 0) {
    return innerMain.text().replace(/\s+/g, " ").trim();
  }

  // Last-resort fallback: an unscoped page. Only here do we strip the
  // sitewide chrome tags before taking the body's text.
  $("nav, footer, header, aside, script, style").remove();
  const text = $("body").text();

  return text.replace(/\s+/g, " ").trim();
}
