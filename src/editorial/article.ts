// src/editorial/article.ts
// Texto legible de un artículo publicado (encabezados, párrafos, listas y tablas) y
// hechos estructurales que el evaluador puede citar como evidencia de enlazado,
// elementos visuales y lectura en móvil.
import * as cheerio from "cheerio";

export interface ArticleDoc {
  text: string;
  facts: string[];
  words: number;
}

export const MAX_ARTICLE_CHARS = 60_000;
const LONG_PARAGRAPH_WORDS = 120;

export function extractArticle(html: string, siteBase: string): ArticleDoc {
  const $ = cheerio.load(html);
  let root = $("article").first();
  if (!root.length) root = $("main main").first();
  if (!root.length) {
    $("nav, footer, header, aside").remove();
    root = $("body");
  }
  root.find("script, style, noscript, svg").remove();

  const lines: string[] = [];
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  let longParagraphs = 0;
  root.find("h1, h2, h3, h4, p, li, tr").each((_, el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "p" && $(el).closest("li, td, th").length) return;
    if (tag === "tr") {
      const cells = $(el).find("th, td").map((__, c) => clean($(c).text())).get();
      if (cells.length) lines.push(`| ${cells.join(" | ")} |`);
      return;
    }
    const t = clean($(el).text());
    if (!t) return;
    if (tag === "h1") lines.push(`# ${t}`);
    else if (tag === "h2") lines.push(`\n## ${t}`);
    else if (tag === "h3" || tag === "h4") lines.push(`\n### ${t}`);
    else if (tag === "li") lines.push(`- ${t}`);
    else {
      if (t.split(" ").length > LONG_PARAGRAPH_WORDS) longParagraphs += 1;
      lines.push(t);
    }
  });
  const text = lines.join("\n").slice(0, MAX_ARTICLE_CHARS);

  const host = new URL(siteBase).host;
  const internal = new Set<string>();
  let external = 0;
  root.find("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    try {
      const u = new URL(href, siteBase);
      if (u.host === host) internal.add(u.pathname);
      else if (u.protocol.startsWith("http")) external += 1;
    } catch {
      /* enlace roto: no cuenta */
    }
  });
  const images = root.find("img");
  const noAlt = images.filter((_, i) => !clean($(i).attr("alt") ?? "")).length;
  const words = (text.match(/\p{L}+/gu) ?? []).length;

  const facts = [
    `palabras: ${words}`,
    `encabezados h2: ${root.find("h2").length}`,
    `imágenes: ${images.length}`,
    `imágenes sin alt: ${noAlt}`,
    `tablas: ${root.find("table").length}`,
    `listas: ${root.find("ul, ol").length}`,
    `párrafos de más de ${LONG_PARAGRAPH_WORDS} palabras: ${longParagraphs}`,
    `enlaces internos: ${internal.size}`,
    `enlaces externos: ${external}`,
    ...[...internal].sort().slice(0, 30).map((p) => `enlace interno: ${p}`),
  ];
  return { text, facts, words };
}
