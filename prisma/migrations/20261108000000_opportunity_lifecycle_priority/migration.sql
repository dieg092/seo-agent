-- Fase 2: ciclo de vida del hallazgo (§6) y factores de la prioridad (§12.2).
-- Solo aditiva: columnas nuevas con valor por defecto; `status` no cambia.

-- AlterTable
ALTER TABLE "seo_agent"."Opportunity"
    ADD COLUMN "state" TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "confirmations" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "absences" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "oscillations" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "oscillationsSince" TIMESTAMP(3),
    ADD COLUMN "dismissedValue" DOUBLE PRECISION,
    ADD COLUMN "staleAt" TIMESTAMP(3),
    ADD COLUMN "page" TEXT,
    ADD COLUMN "operation" TEXT,
    ADD COLUMN "autonomy" TEXT NOT NULL DEFAULT 'A2',
    ADD COLUMN "lane" TEXT NOT NULL DEFAULT 'technical',
    ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'medium',
    ADD COLUMN "confidence" TEXT NOT NULL DEFAULT 'observed',
    ADD COLUMN "businessValue" DOUBLE PRECISION NOT NULL DEFAULT 1,
    ADD COLUMN "priorityFactors" JSONB;

-- Los hallazgos ya resueltos empiezan en `resolved`; el resto, en `open` (ya pasaron
-- su confirmación con el sistema anterior). La siguiente ejecución de prioritize
-- rellena catálogo y factores.
UPDATE "seo_agent"."Opportunity"
SET "state" = 'resolved', "stateChangedAt" = COALESCE("resolvedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'resolved';

-- CreateIndex
CREATE INDEX "Opportunity_state_idx" ON "seo_agent"."Opportunity"("state");

-- CreateIndex
CREATE INDEX "Opportunity_lane_idx" ON "seo_agent"."Opportunity"("lane");
