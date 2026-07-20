ALTER TABLE "seo_agent"."Opportunity"
  ADD COLUMN "reviewedNoActionAt" TIMESTAMP(3),
  ADD COLUMN "reviewedNoActionContentHash" TEXT,
  ADD COLUMN "reviewedNoActionReason" TEXT;
