// scripts/report-workflow-health.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../src/db";
import { reportWorkflowHealth } from "./report-workflow-health";

test("reportWorkflowHealth records status ok and does not alert when no step failed", async () => {
  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-ok" } });
  let alertCalled = false;

  await reportWorkflowHealth({
    workflowName: "test-workflow-ok",
    outcomes: ["success", "success", "skipped"],
    runUrl: "https://example.com/run/1",
    alert: async () => {
      alertCalled = true;
    },
  });

  const heartbeat = await prisma.workflowHeartbeat.findUnique({ where: { workflowName: "test-workflow-ok" } });
  assert.equal(heartbeat?.lastStatus, "ok");
  assert.equal(heartbeat?.lastRunUrl, "https://example.com/run/1");
  assert.equal(alertCalled, false);

  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-ok" } });
});

test("reportWorkflowHealth records status failed and dispatches an alert when any step failed", async () => {
  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-failed" } });
  let alertBody = "";

  await reportWorkflowHealth({
    workflowName: "test-workflow-failed",
    outcomes: ["success", "failure", "skipped"],
    runUrl: "https://example.com/run/2",
    alert: async (args) => {
      alertBody = args.body;
    },
  });

  const heartbeat = await prisma.workflowHeartbeat.findUnique({ where: { workflowName: "test-workflow-failed" } });
  assert.equal(heartbeat?.lastStatus, "failed");
  assert.match(alertBody, /test-workflow-failed/);
  assert.match(alertBody, /https:\/\/example\.com\/run\/2/);

  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-failed" } });
});

test("reportWorkflowHealth upserts the same workflowName on repeated runs", async () => {
  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-upsert" } });

  await reportWorkflowHealth({
    workflowName: "test-workflow-upsert",
    outcomes: ["failure"],
    runUrl: "https://example.com/run/3",
    alert: async () => {},
  });
  await reportWorkflowHealth({
    workflowName: "test-workflow-upsert",
    outcomes: ["success"],
    runUrl: "https://example.com/run/4",
    alert: async () => {},
  });

  const rows = await prisma.workflowHeartbeat.findMany({ where: { workflowName: "test-workflow-upsert" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastStatus, "ok");
  assert.equal(rows[0].lastRunUrl, "https://example.com/run/4");

  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-upsert" } });
});

test("reportWorkflowHealth does not throw when alert dispatch fails (best-effort)", async () => {
  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-alert-fail" } });

  await assert.doesNotReject(() =>
    reportWorkflowHealth({
      workflowName: "test-workflow-alert-fail",
      outcomes: ["failure"],
      runUrl: "https://example.com/run/5",
      alert: async () => {
        throw new Error("DB write failed");
      },
    })
  );

  const heartbeat = await prisma.workflowHeartbeat.findUnique({ where: { workflowName: "test-workflow-alert-fail" } });
  assert.equal(heartbeat?.lastStatus, "failed");

  await prisma.workflowHeartbeat.deleteMany({ where: { workflowName: "test-workflow-alert-fail" } });
});
