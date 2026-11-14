-- Fase 4: interruptor y freno (§14) y registro de despliegues (§13). Solo aditiva.

-- CreateTable
CREATE TABLE "seo_agent"."SeoControl" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "masterSwitch" TEXT NOT NULL DEFAULT 'on',
    "pausedLanes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "brakeState" TEXT NOT NULL DEFAULT 'off',
    "brakeReason" TEXT,
    "trippedAt" TIMESTAMP(3),
    "trippedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeoControl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."DeployEvent" (
    "commitSha" TEXT NOT NULL,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runUrl" TEXT,
    "seoChangeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "DeployEvent_pkey" PRIMARY KEY ("commitSha")
);

-- CreateIndex
CREATE INDEX "DeployEvent_deployedAt_idx" ON "seo_agent"."DeployEvent"("deployedAt");
