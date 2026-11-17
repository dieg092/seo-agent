// scripts/collect-competitors.ts
// Fase 5 (§16.3): una pasada del lector de competidores sobre la lista comercial
// (src/strategy/competitors.ts). Semanal, en weekly-embeddings-and-briefing. Guarda
// solo estructura y el embedding de title + h1 (para los hallazgos competitor-gap).
import { prisma } from "../src/db";
import { embedText } from "../src/embeddings/cloudflareEmbeddings";
import { readCompetitor, REFETCH_DAYS } from "../src/competitors/reader";
import { topicText } from "../src/competitors/gaps";
import { COMMERCIAL_COMPETITORS } from "../src/strategy/competitors";

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  let failures = 0;
  for (const domain of COMMERCIAL_COMPETITORS) {
    try {
      const fetchedThisMonth = await prisma.competitorPage.count({ where: { domain, fetchedAt: { gte: monthStart } } });
      const recent = await prisma.competitorPage.findMany({ where: { domain, fetchedAt: { gte: new Date(now.getTime() - REFETCH_DAYS * DAY_MS) } }, select: { url: true } });
      const { pages, notes } = await readCompetitor(domain, { fetchedThisMonth, recentlyFetched: new Set(recent.map((r) => r.url)) });
      for (const n of notes) console.log(n);
      for (const p of pages) {
        let embedding: number[] = [];
        const text = topicText(p);
        if (p.status === 200 && !p.noindex && text) {
          try {
            embedding = await embedText(text);
          } catch (error) {
            console.error(`${domain}: sin embedding (${String(error).slice(0, 100)})`);
          }
        }
        const data = {
          domain,
          path: p.path,
          status: p.status,
          title: p.title,
          h1: p.h1,
          headings: p.headings,
          jsonLdTypes: p.jsonLdTypes,
          wordCount: p.wordCount,
          lang: p.lang,
          embedding,
          fetchedAt: now,
        };
        await prisma.competitorPage.upsert({ where: { url: p.url }, create: { url: p.url, ...data }, update: data });
      }
    } catch (error) {
      failures += 1;
      console.error(`${domain}: la pasada ha fallado (${String(error).slice(0, 200)})`);
    }
  }
  // Fallar solo si no se ha podido leer ninguno: un competidor que bloquea no es un fallo nuestro.
  return failures === COMMERCIAL_COMPETITORS.length ? 1 : 0;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("Competitor reader failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
