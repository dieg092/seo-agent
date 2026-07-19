// src/embeddings/generateEmbeddings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { generateEmbeddings } from "./generateEmbeddings";

async function resetTable() {
  await prisma.articleEmbedding.deleteMany({});
}

test("generateEmbeddings embeds a new article and stores its content hash", async () => {
  await resetTable();

  const result = await generateEmbeddings({
    getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
    getText: async () => "contenido del artículo a",
    embed: async () => new Array(1024).fill(0.1),
  });

  assert.equal(result.embedded, 1);
  assert.equal(result.skippedUnchanged, 0);

  const stored = await prisma.articleEmbedding.findUnique({ where: { slug: "a" } });
  assert.ok(stored);
  assert.equal(stored?.contentHash.length > 0, true);

  await resetTable();
});

test("generateEmbeddings skips re-embedding when the content hash is unchanged", async () => {
  await resetTable();

  const deps = {
    getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
    getText: async () => "contenido sin cambios",
    embed: async () => new Array(1024).fill(0.2),
  };

  const first = await generateEmbeddings(deps);
  assert.equal(first.embedded, 1);

  let embedCallCount = 0;
  const second = await generateEmbeddings({
    ...deps,
    embed: async () => {
      embedCallCount += 1;
      return new Array(1024).fill(0.2);
    },
  });

  assert.equal(second.embedded, 0);
  assert.equal(second.skippedUnchanged, 1);
  assert.equal(embedCallCount, 0);

  await resetTable();
});

test("generateEmbeddings re-embeds when the article's text actually changed", async () => {
  await resetTable();

  await generateEmbeddings({
    getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
    getText: async () => "versión original",
    embed: async () => new Array(1024).fill(0.1),
  });

  const result = await generateEmbeddings({
    getUrls: async () => [{ slug: "a", url: "https://miwebdeboda.com/blog/a" }],
    getText: async () => "versión actualizada, texto distinto",
    embed: async () => new Array(1024).fill(0.3),
  });

  assert.equal(result.embedded, 1);
  assert.equal(result.skippedUnchanged, 0);

  await resetTable();
});
