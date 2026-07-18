-- CreateTable
CREATE TABLE "seo_agent"."Opportunity" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "sourceRefId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "impactScore" INTEGER NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "effortScore" INTEGER NOT NULL,
    "priorityScore" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."PerformanceAuditResult" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "performanceScore" INTEGER,
    "lcp" DOUBLE PRECISION,
    "cls" DOUBLE PRECISION,
    "inp" DOUBLE PRECISION,
    "errors" JSONB,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceAuditResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_stableKey_key" ON "seo_agent"."Opportunity"("stableKey");

-- CreateIndex
CREATE INDEX "Opportunity_status_idx" ON "seo_agent"."Opportunity"("status");

-- CreateIndex
CREATE INDEX "PerformanceAuditResult_url_idx" ON "seo_agent"."PerformanceAuditResult"("url");

-- CreateIndex
CREATE INDEX "PerformanceAuditResult_runAt_idx" ON "seo_agent"."PerformanceAuditResult"("runAt");
