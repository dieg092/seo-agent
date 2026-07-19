-- AlterTable
ALTER TABLE "seo_agent"."AppliedChange" ADD COLUMN "filePath" TEXT;
ALTER TABLE "seo_agent"."AppliedChange" ADD COLUMN "previousContent" TEXT;
ALTER TABLE "seo_agent"."AppliedChange" ADD COLUMN "revertsAppliedChangeId" TEXT;
