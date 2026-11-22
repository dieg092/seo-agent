-- CreateTable
CREATE TABLE "seo_agent"."AgentReadinessScan" (
    "id" TEXT NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "profile" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "levelName" TEXT NOT NULL,
    "passed" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "checks" JSONB NOT NULL,
    "nextLevel" JSONB,

    CONSTRAINT "AgentReadinessScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentReadinessScan_profile_scannedAt_idx" ON "seo_agent"."AgentReadinessScan"("profile", "scannedAt");
