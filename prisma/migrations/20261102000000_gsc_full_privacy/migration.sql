-- Fase 1: GSC completo, inspección de URLs, sonda de producción e incidentes privados.
-- Solo aditiva: SearchConsoleSnapshot no cambia.

-- CreateTable
CREATE TABLE "seo_agent"."SearchConsolePageDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchConsolePageDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."SearchConsoleQueryTyped" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "isBrand" BOOLEAN NOT NULL DEFAULT false,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchConsoleQueryTyped_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."SearchConsoleSegmentDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "page" TEXT NOT NULL,
    "device" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "clicks" INTEGER NOT NULL,
    "impressions" INTEGER NOT NULL,
    "ctr" DOUBLE PRECISION NOT NULL,
    "position" DOUBLE PRECISION,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchConsoleSegmentDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."GscDataQuality" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "type" TEXT NOT NULL,
    "dataset" TEXT NOT NULL,
    "rowsReturned" INTEGER NOT NULL,
    "capped" BOOLEAN NOT NULL DEFAULT false,
    "pageTotalClicks" INTEGER,
    "queryDetailClicks" INTEGER,
    "anonymizedShare" DOUBLE PRECISION,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GscDataQuality_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."UrlInspection" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inSitemap" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "verdict" TEXT,
    "coverageState" TEXT,
    "indexingState" TEXT,
    "robotsTxtState" TEXT,
    "pageFetchState" TEXT,
    "lastCrawlTime" TIMESTAMP(3),
    "googleCanonical" TEXT,
    "userCanonical" TEXT,
    "crawledAs" TEXT,
    "richResultsVerdict" TEXT,
    "richResultsItems" JSONB,
    "error" TEXT,

    CONSTRAINT "UrlInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."GscSitemapStatus" (
    "id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSubmitted" TIMESTAMP(3),
    "lastDownloaded" TIMESTAMP(3),
    "isPending" BOOLEAN NOT NULL,
    "errors" INTEGER NOT NULL,
    "warnings" INTEGER NOT NULL,
    "contents" JSONB,
    "raw" JSONB NOT NULL,

    CONSTRAINT "GscSitemapStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."ProductionProbeResult" (
    "id" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" INTEGER,
    "finalUrl" TEXT,
    "metaRobots" TEXT,
    "xRobotsTag" TEXT,
    "canonical" TEXT,
    "ok" BOOLEAN NOT NULL,
    "reason" TEXT,

    CONSTRAINT "ProductionProbeResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."PrivateIncident" (
    "id" TEXT NOT NULL,
    "urlHmac" TEXT NOT NULL,
    "urlEncrypted" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sources" TEXT[],
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PrivateIncident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."AnalyticsLandingDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "landingPage" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sessions" INTEGER NOT NULL,
    "engagedSessions" INTEGER NOT NULL,
    "keyEvents" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsLandingDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SearchConsolePageDaily_date_idx" ON "seo_agent"."SearchConsolePageDaily"("date");

-- CreateIndex
CREATE INDEX "SearchConsolePageDaily_page_idx" ON "seo_agent"."SearchConsolePageDaily"("page");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsolePageDaily_date_page_type_key" ON "seo_agent"."SearchConsolePageDaily"("date", "page", "type");

-- CreateIndex
CREATE INDEX "SearchConsoleQueryTyped_date_idx" ON "seo_agent"."SearchConsoleQueryTyped"("date");

-- CreateIndex
CREATE INDEX "SearchConsoleQueryTyped_page_idx" ON "seo_agent"."SearchConsoleQueryTyped"("page");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleQueryTyped_date_page_query_type_key" ON "seo_agent"."SearchConsoleQueryTyped"("date", "page", "query", "type");

-- CreateIndex
CREATE INDEX "SearchConsoleSegmentDaily_date_idx" ON "seo_agent"."SearchConsoleSegmentDaily"("date");

-- CreateIndex
CREATE INDEX "SearchConsoleSegmentDaily_page_idx" ON "seo_agent"."SearchConsoleSegmentDaily"("page");

-- CreateIndex
CREATE UNIQUE INDEX "SearchConsoleSegmentDaily_date_page_device_country_type_key" ON "seo_agent"."SearchConsoleSegmentDaily"("date", "page", "device", "country", "type");

-- CreateIndex
CREATE INDEX "GscDataQuality_date_idx" ON "seo_agent"."GscDataQuality"("date");

-- CreateIndex
CREATE UNIQUE INDEX "GscDataQuality_date_type_dataset_key" ON "seo_agent"."GscDataQuality"("date", "type", "dataset");

-- CreateIndex
CREATE INDEX "UrlInspection_url_inspectedAt_idx" ON "seo_agent"."UrlInspection"("url", "inspectedAt");

-- CreateIndex
CREATE INDEX "UrlInspection_inspectedAt_idx" ON "seo_agent"."UrlInspection"("inspectedAt");

-- CreateIndex
CREATE INDEX "GscSitemapStatus_path_checkedAt_idx" ON "seo_agent"."GscSitemapStatus"("path", "checkedAt");

-- CreateIndex
CREATE INDEX "ProductionProbeResult_runAt_idx" ON "seo_agent"."ProductionProbeResult"("runAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateIncident_urlHmac_key" ON "seo_agent"."PrivateIncident"("urlHmac");

-- CreateIndex
CREATE INDEX "PrivateIncident_resolvedAt_idx" ON "seo_agent"."PrivateIncident"("resolvedAt");

-- CreateIndex
CREATE INDEX "AnalyticsLandingDaily_date_idx" ON "seo_agent"."AnalyticsLandingDaily"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsLandingDaily_date_landingPage_channel_key" ON "seo_agent"."AnalyticsLandingDaily"("date", "landingPage", "channel");
