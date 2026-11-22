-- CreateTable
CREATE TABLE "seo_agent"."CommunitySource" (
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'needs_auth',
    "note" TEXT,
    "cursor" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunitySource_pkey" PRIMARY KEY ("kind")
);

-- CreateTable
CREATE TABLE "seo_agent"."CommunityPost" (
    "id" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "openUrl" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "score" INTEGER NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "CommunityPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."CommunityCard" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "dayMadrid" TEXT NOT NULL,
    "draft" TEXT NOT NULL,
    "mentionsSite" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "campaignCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "discardedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seo_agent"."CommunityDedup" (
    "sourceKind" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disposition" TEXT NOT NULL,

    CONSTRAINT "CommunityDedup_pkey" PRIMARY KEY ("sourceKind","threadKey")
);

-- CreateTable
CREATE TABLE "seo_agent"."CommunityDailyResult" (
    "dayMadrid" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "selected" INTEGER NOT NULL DEFAULT 0,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "discarded" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CommunityDailyResult_pkey" PRIMARY KEY ("dayMadrid","sourceKind")
);

-- CreateTable
CREATE TABLE "seo_agent"."CommunityControl" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunityControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommunityPost_eligible_detectedAt_idx" ON "seo_agent"."CommunityPost"("eligible", "detectedAt");

-- CreateIndex
CREATE INDEX "CommunityPost_expiresAt_idx" ON "seo_agent"."CommunityPost"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityPost_sourceKind_threadKey_key" ON "seo_agent"."CommunityPost"("sourceKind", "threadKey");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityCard_postId_key" ON "seo_agent"."CommunityCard"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityCard_campaignCode_key" ON "seo_agent"."CommunityCard"("campaignCode");

-- CreateIndex
CREATE INDEX "CommunityCard_dayMadrid_status_idx" ON "seo_agent"."CommunityCard"("dayMadrid", "status");

-- CreateIndex
CREATE INDEX "CommunityCard_expiresAt_idx" ON "seo_agent"."CommunityCard"("expiresAt");

-- AddForeignKey
ALTER TABLE "seo_agent"."CommunityCard" ADD CONSTRAINT "CommunityCard_postId_fkey" FOREIGN KEY ("postId") REFERENCES "seo_agent"."CommunityPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Fuentes iniciales: todas apagadas hasta tener acceso verificado.
INSERT INTO "seo_agent"."CommunitySource" ("kind", "enabled", "status", "note", "updatedAt") VALUES
  ('youtube', false, 'needs_auth', 'Falta la clave de la YouTube Data API', NOW()),
  ('reddit', false, 'needs_auth', 'Reddit exige registrar y aprobar la app', NOW()),
  ('telegram', false, 'needs_auth', 'Falta iniciar sesión con la cuenta del fundador', NOW()),
  ('facebook_email', false, 'needs_auth', 'Falta conectar Gmail (solo lectura)', NOW()),
  ('instagram', false, 'needs_review', 'La búsqueda por hashtag exige la revisión de Meta «Instagram Public Content Access»', NOW());
INSERT INTO "seo_agent"."CommunityControl" ("id", "enabled", "updatedAt") VALUES ('global', true, NOW());
