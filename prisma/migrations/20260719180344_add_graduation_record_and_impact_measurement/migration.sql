-- CreateTable
CREATE TABLE "seo_agent"."GraduationRecord" (
    "id" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "consecutiveGood" INTEGER NOT NULL DEFAULT 0,
    "autoMergeEligible" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraduationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GraduationRecord_findingType_key" ON "seo_agent"."GraduationRecord"("findingType");

-- CreateTable
CREATE TABLE "seo_agent"."ImpactMeasurement" (
    "id" TEXT NOT NULL,
    "appliedChangeId" TEXT NOT NULL,
    "findingType" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "beforeMetric" DOUBLE PRECISION NOT NULL,
    "afterMetric" DOUBLE PRECISION NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpactMeasurement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImpactMeasurement_appliedChangeId_key" ON "seo_agent"."ImpactMeasurement"("appliedChangeId");
