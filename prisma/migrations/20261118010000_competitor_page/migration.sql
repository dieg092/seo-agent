-- Fase 5: estructura de las páginas de los competidores (§16.3). Solo aditiva: una tabla nueva.

-- CreateTable
CREATE TABLE "seo_agent"."CompetitorPage" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "title" TEXT,
    "h1" TEXT,
    "headings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "jsonLdTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "lang" TEXT,
    "embedding" DOUBLE PRECISION[] DEFAULT ARRAY[]::DOUBLE PRECISION[],
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorPage_url_key" ON "seo_agent"."CompetitorPage"("url");
CREATE INDEX "CompetitorPage_domain_fetchedAt_idx" ON "seo_agent"."CompetitorPage"("domain", "fetchedAt");
