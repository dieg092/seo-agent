-- Fase 2c: rastreador ligero semanal (§11). Solo aditiva: una tabla nueva.

-- CreateTable
CREATE TABLE "seo_agent"."CrawlPage" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "url" TEXT NOT NULL,
    "inSitemap" BOOLEAN NOT NULL,
    "depth" INTEGER NOT NULL,
    "blockedByRobots" BOOLEAN NOT NULL DEFAULT false,
    "status" INTEGER,
    "redirectTo" TEXT,
    "contentType" TEXT,
    "bytes" INTEGER,
    "durationMs" INTEGER,
    "canonical" TEXT,
    "metaRobots" TEXT,
    "xRobotsTag" TEXT,
    "title" TEXT,
    "h1" TEXT[],
    "internalLinks" TEXT[],
    "privateLinkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrawlPage_runAt_idx" ON "seo_agent"."CrawlPage"("runAt");

-- CreateIndex
CREATE INDEX "CrawlPage_url_idx" ON "seo_agent"."CrawlPage"("url");

-- CreateIndex
CREATE UNIQUE INDEX "CrawlPage_runAt_url_key" ON "seo_agent"."CrawlPage"("runAt", "url");
