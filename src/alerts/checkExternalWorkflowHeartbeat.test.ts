// src/alerts/checkExternalWorkflowHeartbeat.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStaleOrFailed } from "./checkExternalWorkflowHeartbeat";

test("isStaleOrFailed reports stale when there is no run at all", () => {
  const result = isStaleOrFailed(null);
  assert.equal(result.stale, true);
  assert.match(result.reason, /ninguna ejecución/);
});

test("isStaleOrFailed reports stale when the latest run is older than the threshold", () => {
  const now = Date.now();
  const run = {
    conclusion: "success",
    created_at: new Date(now - 30 * 60 * 60 * 1000).toISOString(),
    html_url: "https://example.com",
  };
  const result = isStaleOrFailed(run, { now: () => now, staleAfterHours: 26 });
  assert.equal(result.stale, true);
});

test("isStaleOrFailed reports stale when the latest run did not succeed, even if recent", () => {
  const now = Date.now();
  const run = {
    conclusion: "failure",
    created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    html_url: "https://example.com",
  };
  const result = isStaleOrFailed(run, { now: () => now, staleAfterHours: 26 });
  assert.equal(result.stale, true);
});

test("isStaleOrFailed reports stale when conclusion is null (job never started)", () => {
  const now = Date.now();
  const run = {
    conclusion: null,
    created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    html_url: "https://example.com",
  };
  const result = isStaleOrFailed(run, { now: () => now, staleAfterHours: 26 });
  assert.equal(result.stale, true);
});

test("isStaleOrFailed reports not stale for a recent successful run", () => {
  const now = Date.now();
  const run = {
    conclusion: "success",
    created_at: new Date(now - 1 * 60 * 60 * 1000).toISOString(),
    html_url: "https://example.com",
  };
  const result = isStaleOrFailed(run, { now: () => now, staleAfterHours: 26 });
  assert.equal(result.stale, false);
});
