-- Fase 5: notas editoriales y calibración (§16.4, B5). Solo aditiva: dos tablas nuevas.

-- CreateTable
CREATE TABLE "seo_agent"."EditorialScore" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rubricVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "finalScore" DOUBLE PRECISION NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "deterministic" JSONB NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."EditorialCalibration" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "references" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialCalibration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EditorialScore_slug_createdAt_idx" ON "seo_agent"."EditorialScore"("slug", "createdAt");
CREATE INDEX "EditorialCalibration_createdAt_idx" ON "seo_agent"."EditorialCalibration"("createdAt");
