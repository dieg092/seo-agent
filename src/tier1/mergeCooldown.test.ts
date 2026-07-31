// src/tier1/mergeCooldown.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinMergeCooldown } from "./mergeCooldown";

test("isWithinMergeCooldown returns false when there is no previous merge", () => {
  assert.equal(isWithinMergeCooldown(null, new Date(), 24), false);
});

test("isWithinMergeCooldown returns true when the last merge was within the cooldown window", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const lastMergeAt = new Date("2026-07-31T11:00:00.000Z"); // 1h ago
  assert.equal(isWithinMergeCooldown(lastMergeAt, now, 24), true);
});

test("isWithinMergeCooldown returns false once the cooldown window has fully elapsed", () => {
  const now = new Date("2026-08-01T12:00:00.000Z");
  const lastMergeAt = new Date("2026-07-31T11:00:00.000Z"); // 25h ago
  assert.equal(isWithinMergeCooldown(lastMergeAt, now, 24), false);
});

test("isWithinMergeCooldown treats the exact boundary as elapsed, not blocked", () => {
  const now = new Date("2026-08-01T11:00:00.000Z");
  const lastMergeAt = new Date("2026-07-31T11:00:00.000Z"); // exactly 24h ago
  assert.equal(isWithinMergeCooldown(lastMergeAt, now, 24), false);
});

test("isWithinMergeCooldown respects a custom cooldown length", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const lastMergeAt = new Date("2026-07-31T10:30:00.000Z"); // 1h30 ago
  assert.equal(isWithinMergeCooldown(lastMergeAt, now, 1), false); // 1h cooldown, already elapsed
  assert.equal(isWithinMergeCooldown(lastMergeAt, now, 2), true); // 2h cooldown, still active
});
