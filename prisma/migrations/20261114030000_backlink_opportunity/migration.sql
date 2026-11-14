-- Fase 5: oportunidades de enlace (§16.7). Solo aditiva: una tabla nueva.

-- CreateTable
CREATE TABLE "seo_agent"."BacklinkOpportunity" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "candidatePage" TEXT,
    "kind" TEXT NOT NULL,
    "relevance" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "probability" TEXT NOT NULL,
    "risks" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idea',
    "actions" TEXT,
    "verifiedLink" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BacklinkOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BacklinkOpportunity_domain_candidatePage_key" ON "seo_agent"."BacklinkOpportunity"("domain", "candidatePage");
CREATE INDEX "BacklinkOpportunity_status_idx" ON "seo_agent"."BacklinkOpportunity"("status");
