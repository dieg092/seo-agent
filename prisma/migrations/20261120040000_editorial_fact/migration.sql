CREATE TABLE "seo_agent"."EditorialFact" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "forms" TEXT[],
    "statement" TEXT NOT NULL,
    "context" TEXT[],
    "contextMin" INTEGER NOT NULL,
    "cite" TEXT[],
    "names" TEXT[],
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "sampleSize" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EditorialFact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EditorialFact_key_key" ON "seo_agent"."EditorialFact"("key");
CREATE INDEX "EditorialFact_active_verifiedAt_idx" ON "seo_agent"."EditorialFact"("active", "verifiedAt");
