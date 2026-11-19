ALTER TABLE "seo_agent"."SeoTaskLink" ADD COLUMN "guardErrors" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "guardRetryAt" TIMESTAMP(3);

CREATE TABLE "seo_agent"."EditorialBatteryRun" (
    "id" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "quotaHits" INTEGER NOT NULL DEFAULT 0,
    "transientFails" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialBatteryRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EditorialBatteryRun_configKey_createdAt_idx" ON "seo_agent"."EditorialBatteryRun"("configKey", "createdAt");

CREATE TABLE "seo_agent"."EditorialBatterySample" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "sampleIndex" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialBatterySample_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EditorialBatterySample_runId_caseId_side_sampleIndex_key" ON "seo_agent"."EditorialBatterySample"("runId", "caseId", "side", "sampleIndex");

CREATE TABLE "seo_agent"."EditorialBatteryCaseResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "critical" BOOLEAN NOT NULL,
    "detected" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialBatteryCaseResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EditorialBatteryCaseResult_runId_caseId_key" ON "seo_agent"."EditorialBatteryCaseResult"("runId", "caseId");

CREATE TABLE "seo_agent"."EditorialBudget" (
    "day" TEXT NOT NULL,
    "background" INTEGER NOT NULL DEFAULT 0,
    "guard" INTEGER NOT NULL DEFAULT 0,
    "quotaUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialBudget_pkey" PRIMARY KEY ("day")
);
