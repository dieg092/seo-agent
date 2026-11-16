// src/revert/regression.ts
// Regresiones técnicas de un cambio SEO ya desplegado (§15.3, prueba 14) y la
// reversión determinista. Lógica pura: la sonda y git están en runRevert.ts.
import { createHash } from "node:crypto";

export const REGRESSION_TYPE = "change-regression";
export const REVERT_LABEL = "seo-revert";

/** Páginas que deben ser noindex: la del canario. En las demás, un noindex nuevo es una regresión. */
export const NOINDEX_PAGES = new Set(["https://miwebdeboda.com/seo-canario"]);

export interface PageProbe {
  status: number;
  title: string | null;
  robots: string | null;
}

/** Lo que una página tocada por un cambio SEO no puede perder: responder, tener title y su indexación. */
export function regressionReasons(url: string, p: PageProbe): string[] {
  const out: string[] = [];
  if (p.status < 200 || p.status >= 400) out.push(`responde ${p.status}`);
  if (!p.title || !p.title.trim()) out.push("title vacío");
  const noindex = /noindex/i.test(p.robots ?? "");
  if (noindex && !NOINDEX_PAGES.has(url)) out.push("noindex nuevo");
  if (!noindex && NOINDEX_PAGES.has(url)) out.push("ha perdido el noindex");
  return out;
}

/** title y meta robots del HTML (sin dependencias: lo justo para la sonda). */
export function parseHead(html: string): { title: string | null; robots: string | null } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  const meta = /<meta[^>]+name=["']robots["'][^>]*>/i.exec(html)?.[0] ?? "";
  const robots = /content=["']([^"']*)["']/i.exec(meta)?.[1] ?? null;
  return { title: title === null ? null : decode(title).trim(), robots };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export const regressionKey = (changeId: string) => createHash("sha256").update(`${REGRESSION_TYPE}:${changeId}`).digest("hex");

/** Commit de main del cambio: el primero cuyo asunto empieza por `seo(<id8>)`. Ya revertido si hay un `Revert "seo(<id8>)…`. */
export function findChangeCommit(log: { sha: string; subject: string }[], changeId: string): { sha: string | null; reverted: boolean } {
  const tag = `seo(${changeId.toLowerCase()})`;
  const reverted = log.some((c) => c.subject.toLowerCase().startsWith(`revert "${tag}`));
  const hit = log.find((c) => c.subject.toLowerCase().startsWith(tag));
  return { sha: hit?.sha ?? null, reverted };
}

export const revertBranch = (changeId: string) => `ia/seo/revert-${changeId}`;
