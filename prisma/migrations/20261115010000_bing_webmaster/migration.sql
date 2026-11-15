-- Fase 6: Bing Webmaster (§10.6). Solo aditiva: tres tablas nuevas.

CREATE TABLE "seo_agent"."BingQueryStat" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "query" TEXT NOT NULL,
    "isBrand" BOOLEAN NOT NULL DEFAULT false,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "avgImpressionPosition" DOUBLE PRECISION NOT NULL,
    "avgClickPosition" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BingQueryStat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BingQueryStat_date_query_key" ON "seo_agent"."BingQueryStat"("date", "query");
CREATE INDEX "BingQueryStat_date_idx" ON "seo_agent"."BingQueryStat"("date");

CREATE TABLE "seo_agent"."BingPageStat" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "avgImpressionPosition" DOUBLE PRECISION NOT NULL,
    "avgClickPosition" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BingPageStat_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BingPageStat_date_page_key" ON "seo_agent"."BingPageStat"("date", "page");
CREATE INDEX "BingPageStat_date_idx" ON "seo_agent"."BingPageStat"("date");

CREATE TABLE "seo_agent"."BingCrawlStat" (
    "date" DATE NOT NULL,
    "crawledPages" INTEGER NOT NULL,
    "inIndex" INTEGER NOT NULL,
    "inLinks" INTEGER NOT NULL,
    "code2xx" INTEGER NOT NULL,
    "code301" INTEGER NOT NULL,
    "code302" INTEGER NOT NULL,
    "code4xx" INTEGER NOT NULL,
    "code5xx" INTEGER NOT NULL,
    "blockedByRobotsTxt" INTEGER NOT NULL,
    "crawlErrors" INTEGER NOT NULL,
    "allOtherCodes" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BingCrawlStat_pkey" PRIMARY KEY ("date")
);
