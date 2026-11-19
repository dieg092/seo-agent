// src/editorial/evidenceStore.ts
// Refresco del catálogo de evidencia admitida (una vez al día, desde el puente) y su lectura
// para la guarda y el prompt. Cada fuente se refresca por separado: si una falla, sus datos se
// quedan como estaban y caducan solos a los 14 días (EVIDENCE_MAX_AGE_DAYS); las demás siguen.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as cheerio from "cheerio";
import { prisma } from "../db";
import { getEnv } from "../env";
import { fetchSitemapEntries } from "../collectors/urlInspectionCollector";
import { withAppFunnelReader } from "../collectors/funnelOrganicCollector";
import { extractArticle } from "./article";
import {
  EVIDENCE_MAX_AGE_DAYS,
  EVIDENCE_REFRESH_HOURS,
  MIN_WEDDINGS,
  factsFromBank,
  factsFromPage,
  factsFromWeddingRows,
  productFacts,
  type Fact,
  type FactKind,
  type WeddingFactRow,
} from "./evidence";

const DAY = 86_400_000;
/** Páginas de datos de la propia web cuyas frases con cifra entran como evidencia. */
export const DATA_PAGE = /^\/estadisticas-bodas(\/[a-z0-9-]+)?$/;

export interface EvidenceDeps {
  readBank: () => Promise<string>;
  dataPages: () => Promise<{ path: string; html: string }[]>;
  weddingRows: () => Promise<WeddingFactRow[]>;
}

const APP_DIR = () => process.env.WEDDING_INVITE_2_DIR ?? join(__dirname, "..", "..", "..", "wedding-invite-2");

export const defaultEvidenceDeps: EvidenceDeps = {
  readBank: async () => {
    execFileSync("git", ["-C", APP_DIR(), "fetch", "-q", "origin", "main"], { stdio: "ignore", timeout: 120_000 });
    return execFileSync("git", ["-C", APP_DIR(), "show", "origin/main:src/lib/blog/facts-bank.md"], { encoding: "utf8", maxBuffer: 8_000_000 });
  },
  dataPages: async () => {
    const base = getEnv("SITE_BASE_URL").replace(/\/+$/, "");
    const urls = (await fetchSitemapEntries({ baseUrl: base })).map((e) => new URL(e.url)).filter((u) => DATA_PAGE.test(u.pathname.replace(/\/+$/, "")));
    const out: { path: string; html: string }[] = [];
    for (const u of urls.slice(0, 60)) {
      const res = await fetch(u.toString(), { headers: { "user-agent": "miwebdeboda-seo-agent-evidence" }, signal: AbortSignal.timeout(20_000) });
      if (res.ok) out.push({ path: u.pathname.replace(/\/+$/, ""), html: await res.text() });
    }
    if (!out.length) throw new Error("ninguna página de datos respondió");
    return out;
  },
  weddingRows: async () => {
    const url = process.env.APP_FUNNEL_DATABASE_URL;
    if (!url) throw new Error("sin APP_FUNNEL_DATABASE_URL");
    return withAppFunnelReader(url, (tx) => tx.$queryRawUnsafe<WeddingFactRow[]>("SELECT metric, value::float8 AS value, unit, n_bodas, n_registros, desde, hasta FROM seo_wedding_facts"));
  },
};

/** Frases con cifra de una página de datos y los dominios de las fuentes que enlaza. */
export function pageFacts(path: string, html: string, siteBase: string): Fact[] {
  const $ = cheerio.load(html);
  const hosts = new Set<string>();
  $("a[href^='http']").each((_, a) => {
    try {
      const h = new URL($(a).attr("href")!).hostname.replace(/^www\./, "");
      if (!h.endsWith("miwebdeboda.com")) hosts.add(h);
    } catch {
      // enlace roto
    }
  });
  return factsFromPage(path, extractArticle(html, siteBase).text, [...hosts]);
}

async function replaceKind(kind: FactKind, facts: Fact[], now: Date) {
  await prisma.$transaction([
    prisma.editorialFact.updateMany({ where: { kind, key: { notIn: facts.map((f) => f.key) } }, data: { active: false } }),
    ...facts.map((f) =>
      prisma.editorialFact.upsert({
        where: { key: f.key },
        create: { ...f, active: true, verifiedAt: now },
        update: { ...f, active: true, verifiedAt: now },
      }),
    ),
  ]);
}

/** Refresca las fuentes si toca (cada 24 h). Devuelve una nota para el registro del puente. */
export async function refreshEvidence(now: Date, deps: EvidenceDeps = defaultEvidenceDeps, opts: { force?: boolean } = {}): Promise<string> {
  const last = await prisma.editorialFact.findFirst({ where: { active: true }, orderBy: { verifiedAt: "desc" } });
  if (!opts.force && last && now.getTime() - last.verifiedAt.getTime() < EVIDENCE_REFRESH_HOURS * 3_600_000) return "";
  const siteBase = getEnv("SITE_BASE_URL").replace(/\/+$/, "");
  const notes: string[] = [];
  let sample = "";
  const sources: [FactKind, () => Promise<Fact[]>][] = [
    ["producto", async () => productFacts()],
    ["banco", async () => factsFromBank(await deps.readBank())],
    ["web", async () => (await deps.dataPages()).flatMap((p) => pageFacts(p.path, p.html, siteBase))],
    [
      "propio",
      async () => {
        const rows = await deps.weddingRows();
        const n = rows.find((r) => r.metric === "muestra:bodas");
        if (n) sample = ` (muestra: ${Number(n.value)} bodas; hacen falta ${MIN_WEDDINGS} por cifra)`;
        return factsFromWeddingRows(rows);
      },
    ],
  ];
  for (const [kind, load] of sources) {
    try {
      const facts = await load();
      // Una fuente que de repente sale vacía no borra lo que había (caduca sola si sigue así).
      if (!facts.length && (kind === "banco" || kind === "producto")) throw new Error("sin datos");
      await replaceKind(kind, facts, now);
      notes.push(`${kind} ${facts.length}`);
    } catch (e) {
      const msg = (e as Error).message.replace(/\s+/g, " ");
      notes.push(`${kind} sin refrescar (${/42P01/.test(msg) ? "la vista aún no existe" : msg.slice(0, 80)})`);
    }
  }
  return `evidencia admitida: ${notes.join(", ")}${sample}`;
}

/** Catálogo vigente: datos activos verificados en los últimos 14 días. */
export async function loadFacts(now: Date): Promise<Fact[]> {
  const rows = await prisma.editorialFact.findMany({ where: { active: true, verifiedAt: { gte: new Date(now.getTime() - EVIDENCE_MAX_AGE_DAYS * DAY) } }, orderBy: { key: "asc" } });
  return rows.map((r) => ({
    key: r.key,
    kind: r.kind as FactKind,
    forms: r.forms,
    statement: r.statement,
    context: r.context,
    contextMin: r.contextMin,
    cite: r.cite,
    names: r.names,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    sampleSize: r.sampleSize,
  }));
}
