CREATE TABLE "seo_agent"."RepairIncident" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "prUrl" TEXT,
    "baseSha" TEXT,
    "mergedSha" TEXT,
    "verifyUntil" TIMESTAMP(3),
    "result" JSONB,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RepairIncident_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RepairIncident_key_key" ON "seo_agent"."RepairIncident"("key");
CREATE INDEX "RepairIncident_status_idx" ON "seo_agent"."RepairIncident"("status");
