// src/alerts/checkPatExpiration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPatExpiration } from "./checkPatExpiration";

test("checkPatExpiration returns daysRemaining when the header is present", () => {
  const expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const headers = new Headers({
    "github-authentication-token-expiration": expiresAt.toUTCString(),
  });

  const result = checkPatExpiration(headers);

  assert.ok(result);
  assert.ok(result!.daysRemaining >= 9 && result!.daysRemaining <= 10);
});

test("checkPatExpiration returns null when the header is absent", () => {
  const result = checkPatExpiration(new Headers());
  assert.equal(result, null);
});
