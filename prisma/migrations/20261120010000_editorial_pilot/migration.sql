ALTER TABLE "seo_agent"."SeoChange" ADD COLUMN "revertSha" TEXT, ADD COLUMN "revertVerifiedAt" TIMESTAMP(3);

CREATE TABLE "seo_agent"."EditorialPilot" (
    "id" TEXT NOT NULL,
    "orbitaTaskId" TEXT NOT NULL,
    "page" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL,
    "deployedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialPilot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EditorialPilot_orbitaTaskId_key" ON "seo_agent"."EditorialPilot"("orbitaTaskId");
CREATE INDEX "EditorialPilot_state_idx" ON "seo_agent"."EditorialPilot"("state");

CREATE TABLE "seo_agent"."EditorialBattery" (
    "id" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detected" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "criticalMissed" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EditorialBattery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EditorialBattery_configKey_createdAt_idx" ON "seo_agent"."EditorialBattery"("configKey", "createdAt");
