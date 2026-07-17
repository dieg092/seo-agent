-- CreateTable
CREATE TABLE "seo_agent"."SearchConsoleSnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SearchConsoleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL,
    "engagedSessions" INTEGER NOT NULL,
    "conversions" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."SitemapAuditResult" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "urlCount" INTEGER NOT NULL,
    "staleEntries" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,

    CONSTRAINT "SitemapAuditResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."RobotsAuditResult" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isValid" BOOLEAN NOT NULL,
    "errors" JSONB NOT NULL,

    CONSTRAINT "RobotsAuditResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."StructuredDataAuditResult" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT NOT NULL,
    "schemaType" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL,
    "errors" JSONB NOT NULL,

    CONSTRAINT "StructuredDataAuditResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleSnapshot_date_page_query_key" ON "seo_agent"."SearchConsoleSnapshot"("date", "page", "query");

-- CreateIndex
CREATE INDEX "SearchConsoleSnapshot_date_idx" ON "seo_agent"."SearchConsoleSnapshot"("date");

-- CreateIndex
CREATE INDEX "SearchConsoleSnapshot_page_idx" ON "seo_agent"."SearchConsoleSnapshot"("page");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsSnapshot_date_page_channel_key" ON "seo_agent"."AnalyticsSnapshot"("date", "page", "channel");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_date_idx" ON "seo_agent"."AnalyticsSnapshot"("date");

-- CreateIndex
CREATE INDEX "StructuredDataAuditResult_url_idx" ON "seo_agent"."StructuredDataAuditResult"("url");
