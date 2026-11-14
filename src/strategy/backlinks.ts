// src/strategy/backlinks.ts
// Comprobación de enlaces conseguidos (§16.7): la página del tercero tiene que
// enlazar de verdad a miwebdeboda.com. Lógica pura sobre el HTML; la descarga
// está en scripts/verify-backlinks.ts (1 petición cada 5 s, respetando robots).

/** Enlaces <a href> del HTML que apuntan a miwebdeboda.com, con su rel. */
export function linksToSite(html: string): { href: string; rel: string }[] {
  const out: { href: string; rel: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attrs = m[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!href || !/^(https?:)?\/\/(www\.)?miwebdeboda\.com(\/|$|\?|#)/i.test(href)) continue;
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    out.push({ href, rel: rel.toLowerCase() });
  }
  return out;
}

export type BacklinkCheck = { found: true; follow: boolean; href: string } | { found: false };

export function checkBacklink(html: string): BacklinkCheck {
  const links = linksToSite(html);
  if (links.length === 0) return { found: false };
  const follow = links.find((l) => !/\b(nofollow|ugc|sponsored)\b/.test(l.rel));
  return { found: true, follow: Boolean(follow), href: (follow ?? links[0]).href };
}
