-- CreateTable
CREATE TABLE "seo_agent"."WorkflowHeartbeat" (
    "id" TEXT NOT NULL,
    "workflowName" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastStatus" TEXT NOT NULL,
    "lastRunUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowHeartbeat_workflowName_key" ON "seo_agent"."WorkflowHeartbeat"("workflowName");
