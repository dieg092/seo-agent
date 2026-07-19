-- CreateTable
CREATE TABLE "seo_agent"."ArticleEmbedding" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embedding" vector(1024),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArticleEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ArticleEmbedding_slug_key" ON "seo_agent"."ArticleEmbedding"("slug");

-- CreateTable
CREATE TABLE "seo_agent"."LinkSuggestion" (
    "id" TEXT NOT NULL,
    "sourceSlug" TEXT NOT NULL,
    "targetSlug" TEXT NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "stableKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkSuggestion_stableKey_key" ON "seo_agent"."LinkSuggestion"("stableKey");

-- CreateIndex
CREATE INDEX "LinkSuggestion_status_idx" ON "seo_agent"."LinkSuggestion"("status");

-- CreateIndex (HNSW, for cosine-similarity search — same pattern as wedding-invite-2's PhotoAsset/ArticleSlot)
CREATE INDEX "ArticleEmbedding_embedding_idx" ON "seo_agent"."ArticleEmbedding" USING hnsw ("embedding" vector_cosine_ops);
