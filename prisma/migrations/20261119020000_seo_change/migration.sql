-- Registro de cambios SEO automáticos (riesgo 2): tarea → commit seo(<id8>) → primer despliegue → medición.
CREATE TABLE "seo_agent"."SeoChange" (
    "id" TEXT NOT NULL,
    "orbitaTaskId" TEXT NOT NULL,
    "changeId8" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "operation" TEXT,
    "page" TEXT,
    "status" TEXT NOT NULL,
    "deployCommitSha" TEXT,
    "deployedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "outcomeDetail" JSONB,
    "measuredAt" TIMESTAMP(3),
    "confirmAfter" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SeoChange_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeoChange_orbitaTaskId_key" ON "seo_agent"."SeoChange"("orbitaTaskId");
CREATE INDEX "SeoChange_status_idx" ON "seo_agent"."SeoChange"("status");
CREATE INDEX "SeoChange_changeId8_idx" ON "seo_agent"."SeoChange"("changeId8");
