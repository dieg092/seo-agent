-- Fase 2: embudo orgánico de la app (vista seo_funnel_daily) en FunnelOrganicDaily.
-- Solo aditiva: crea una tabla nueva y sus índices.

-- CreateTable
CREATE TABLE "seo_agent"."FunnelOrganicDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "landingPath" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "registros" INTEGER NOT NULL,
    "bodasPublicadas" INTEGER NOT NULL,
    "primerasConfirmaciones" INTEGER NOT NULL,
    "pagos" INTEGER NOT NULL,
    "revenueCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FunnelOrganicDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FunnelOrganicDaily_date_landingPath_channel_key" ON "seo_agent"."FunnelOrganicDaily"("date", "landingPath", "channel");

-- CreateIndex
CREATE INDEX "FunnelOrganicDaily_date_idx" ON "seo_agent"."FunnelOrganicDaily"("date");

-- CreateIndex
CREATE INDEX "FunnelOrganicDaily_landingPath_idx" ON "seo_agent"."FunnelOrganicDaily"("landingPath");
