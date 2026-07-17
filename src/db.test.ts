import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./db";

test("prisma client can read from the seo_agent schema", async () => {
  const count = await prisma.searchConsoleSnapshot.count();
  assert.equal(typeof count, "number");
});
