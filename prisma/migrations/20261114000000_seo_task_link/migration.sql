-- Fase 3: puente con Órbita (anexo C.5). Solo aditiva: una tabla nueva.

-- CreateTable
CREATE TABLE "seo_agent"."SeoTaskLink" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "orbitaTaskId" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "operation" TEXT,
    "page" TEXT,
    "lane" TEXT NOT NULL,
    "autonomy" TEXT NOT NULL,
    "contract" JSONB NOT NULL,
    "taskStatus" TEXT NOT NULL DEFAULT 'todo',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,

    CONSTRAINT "SeoTaskLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SeoTaskLink_orbitaTaskId_key" ON "seo_agent"."SeoTaskLink"("orbitaTaskId");
CREATE INDEX "SeoTaskLink_stableKey_idx" ON "seo_agent"."SeoTaskLink"("stableKey");
CREATE INDEX "SeoTaskLink_closedAt_idx" ON "seo_agent"."SeoTaskLink"("closedAt");
CREATE INDEX "SeoTaskLink_createdAt_idx" ON "seo_agent"."SeoTaskLink"("createdAt");
