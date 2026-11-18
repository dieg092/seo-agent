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

/** Texto del artículo en un fichero de wedding-invite-2 (`const content = \`…\`;`), o null si no lo es. */
export function contentFromSource(source: string): string | null {
  const start = source.indexOf("= `");
  const end = source.lastIndexOf("`");
  if (start < 0 || end <= start + 2) return null;
  return source.slice(start + 3, end).replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\\/g, "\\");
}

/** Lo mismo que extractArticle, pero desde el markdown del repositorio (la versión de un PR aún sin publicar). */
export function extractArticleFromMarkdown(md: string, siteBase: string, title?: string): ArticleDoc {
  const host = new URL(siteBase).host;
  const internal = new Set<string>();
  let external = 0;
  let images = 0;
  let noAlt = 0;
  let tables = 0;
  let lists = 0;
  let longParagraphs = 0;
  let h2 = 0;
  const addLink = (href: string) => {
    try {
      const u = new URL(href, siteBase);
      if (u.host === host) internal.add(u.pathname);
      else if (u.protocol.startsWith("http")) external += 1;
    } catch {
      /* enlace roto: no cuenta */
    }
  };
  const inline = (s: string) =>
    s
      .replace(/<img\b[^>]*>/gi, (tag) => {
        images += 1;
        if (!/\balt="[^"]*\S[^"]*"/i.test(tag)) noAlt += 1;
        return "";
      })
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => {
        images += 1;
        if (!alt.trim()) noAlt += 1;
        return "";
      })
      .replace(/<a\b[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_, href: string, t: string) => {
        addLink(href);
        return t;
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, href: string) => {
        addLink(href);
        return t;
      })
      .replace(/<[^>]+>/g, "")
      .replace(/\*\*|__|(?<!\w)[*_](?!\s)|`/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const lines: string[] = title ? [`# ${title}`] : [];
  let inTable = false;
  let inList = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const isTable = line.startsWith("|");
    const isItem = /^([-*+]|\d+[.)])\s+/.test(line);
    if (isTable && !inTable) tables += 1;
    if (isItem && !inList) lists += 1;
    inTable = isTable;
    inList = isItem;
    if (!line || /^\|?\s*:?-{2,}/.test(line)) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const t = inline(h[2]);
      if (h[1].length === 2) h2 += 1;
      lines.push(h[1].length === 1 ? `# ${t}` : h[1].length === 2 ? `\n## ${t}` : `\n### ${t}`);
    } else if (isTable) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map(inline);
      lines.push(`| ${cells.join(" | ")} |`);
    } else if (isItem) {
      const t = inline(line.replace(/^([-*+]|\d+[.)])\s+/, ""));
      if (t) lines.push(`- ${t}`);
    } else {
      const t = inline(line.replace(/^>\s*/, ""));
      if (!t) continue;
      if (t.split(" ").length > LONG_PARAGRAPH_WORDS) longParagraphs += 1;
      lines.push(t);
    }
  }
  const text = lines.join("\n").slice(0, MAX_ARTICLE_CHARS);
  const words = (text.match(/\p{L}+/gu) ?? []).length;
  const facts = [
    `palabras: ${words}`,
    `encabezados h2: ${h2}`,
    `imágenes: ${images}`,
    `imágenes sin alt: ${noAlt}`,
    `tablas: ${tables}`,
    `listas: ${lists}`,
    `párrafos de más de ${LONG_PARAGRAPH_WORDS} palabras: ${longParagraphs}`,
    `enlaces internos: ${internal.size}`,
    `enlaces externos: ${external}`,
    ...[...internal].sort().slice(0, 30).map((p) => `enlace interno: ${p}`),
  ];
  return { text, facts, words };
}
