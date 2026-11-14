-- Fase 5: palabras clave y clústeres (§16.1-16.2). Solo aditiva: dos tablas nuevas.

-- CreateTable
CREATE TABLE "seo_agent"."KeywordCandidate" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "impressions90d" INTEGER NOT NULL,
    "clicks90d" INTEGER NOT NULL,
    "avgPosition" DOUBLE PRECISION NOT NULL,
    "bestPage" TEXT,
    "bestPagePosition" DOUBLE PRECISION,
    "demand" TEXT NOT NULL,
    "clusterId" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeywordCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."TopicCluster" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "mainPage" TEXT,
    "mainPagePosition" DOUBLE PRECISION,
    "hasProductPage" BOOLEAN NOT NULL,
    "queryCount" INTEGER NOT NULL,
    "impressions90d" INTEGER NOT NULL,
    "clicks90d" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicCluster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KeywordCandidate_query_key" ON "seo_agent"."KeywordCandidate"("query");
CREATE INDEX "KeywordCandidate_clusterId_idx" ON "seo_agent"."KeywordCandidate"("clusterId");
