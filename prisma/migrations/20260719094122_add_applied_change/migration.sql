-- CreateTable
CREATE TABLE "seo_agent"."AppliedChange" (
    "id" TEXT NOT NULL,
    "opportunityStableKey" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "prUrl" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppliedChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppliedChange_opportunityStableKey_idx" ON "seo_agent"."AppliedChange"("opportunityStableKey");

-- CreateIndex
CREATE INDEX "AppliedChange_status_idx" ON "seo_agent"."AppliedChange"("status");
