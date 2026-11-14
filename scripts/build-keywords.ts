// scripts/build-keywords.ts
// Fase 5 (§16.1-16.2): reconstruye KeywordCandidate y TopicCluster con las
// consultas no-marca de GSC de 90 días (≥ 5 impresiones, como mucho 800).
// Solo pide embedding (bge-m3, Cloudflare) de las consultas nuevas.
import { randomUUID } from "node:crypto";
import { prisma } from "../src/db";
import { isBrandQuery } from "../src/collectors/brand";
import { embedText } from "../src/embeddings/cloudflareEmbeddings";
import { buildKeywordRows, clusterQueries, summarizeClusters } from "../src/strategy/keywords";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_IMPRESSIONS = 5;
const MAX_QUERIES = 800;

async function main(): Promise<number> {
  try {
    const rows = await prisma.searchConsoleSnapshot.findMany({
      where: { date: { gte: new Date(Date.now() - 90 * DAY_MS) } },
      select: { query: true, page: true, impressions: true, clicks: true, position: true },
    });
    const keywords = buildKeywordRows(rows.filter((r) => !isBrandQuery(r.query)))
      .filter((k) => k.impressions90d >= MIN_IMPRESSIONS)
      .slice(0, MAX_QUERIES);

    const stored = new Map(
      (await prisma.keywordCandidate.findMany({ select: { query: true, embedding: true } })).map((k) => [k.query, k.embedding]),
    );
    let embedded = 0;
    const withEmbedding: { query: string; impressions: number; embedding: number[] }[] = [];
    for (const k of keywords) {
      let embedding = stored.get(k.query) ?? [];
      if (embedding.length === 0) {
        try {
          embedding = await embedText(k.query);
          embedded += 1;
        } catch (error) {
          console.error(`Sin embedding para una consulta (${String(error).slice(0, 120)})`);
          embedding = [];
        }
      }
      withEmbedding.push({ query: k.query, impressions: k.impressions90d, embedding });
    }

    const assignment = clusterQueries(withEmbedding);
    const clusters = summarizeClusters(keywords, assignment);
    const clusterIdByLabel = new Map(clusters.map((c) => [c.label, randomUUID()]));
    const embeddingOf = new Map(withEmbedding.map((w) => [w.query, w.embedding]));

    await prisma.$transaction(async (tx) => {
      await tx.keywordCandidate.deleteMany({ where: { query: { notIn: keywords.map((k) => k.query) } } });
      await tx.topicCluster.deleteMany({});
      await tx.topicCluster.createMany({
        data: clusters.map(({ queries: _q, ...c }) => ({ id: clusterIdByLabel.get(c.label)!, ...c })),
      });
      for (const k of keywords) {
        const center = assignment.get(k.query);
        const data = { ...k, clusterId: center ? clusterIdByLabel.get(center) ?? null : null, embedding: embeddingOf.get(k.query) ?? [] };
        await tx.keywordCandidate.upsert({ where: { query: k.query }, create: data, update: data });
      }
    }, { timeout: 120_000 });

    const byIntent = keywords.reduce<Record<string, number>>((a, k) => ((a[k.intent] = (a[k.intent] ?? 0) + 1), a), {});
    console.log(
      `Palabras clave: ${keywords.length} consultas (${embedded} embeddings nuevos), ${clusters.length} clústeres. Intención: ${Object.entries(byIntent)
        .map(([i, n]) => `${i} ${n}`)
        .join(", ")}`,
    );
    return 0;
  } catch (error) {
    console.error("build-keywords failed:", error);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
