// src/embeddings/cloudflareEmbeddings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { embedText } from "./cloudflareEmbeddings";

test("embedText returns the vector from the first account that succeeds", async () => {
  const fetchImpl = async () =>
    ({
      ok: true,
      json: async () => ({ result: { data: [[0.1, 0.2, 0.3]] } }),
    }) as Response;

  const vector = await embedText("texto de prueba", {
    fetchImpl,
    accounts: [{ token: "t1", accountId: "a1", label: "cuenta test" }],
  });

  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
});

test("embedText falls back to the next account when the first fails", async () => {
  let callCount = 0;
  const fetchImpl = async () => {
    callCount += 1;
    if (callCount === 1) return { ok: false, status: 500 } as Response;
    return { ok: true, json: async () => ({ result: { data: [[0.4, 0.5]] } }) } as Response;
  };

  const vector = await embedText("texto", {
    fetchImpl,
    accounts: [
      { token: "t1", accountId: "a1", label: "cuenta 1" },
      { token: "t2", accountId: "a2", label: "cuenta 2" },
    ],
  });

  assert.deepEqual(vector, [0.4, 0.5]);
  assert.equal(callCount, 2);
});

test("embedText throws when no accounts are configured", async () => {
  await assert.rejects(
    () => embedText("texto", { accounts: [] }),
    /No hay ninguna cuenta/
  );
});

test("embedText throws when every account fails", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 }) as Response;

  await assert.rejects(
    () =>
      embedText("texto", {
        fetchImpl,
        accounts: [{ token: "t1", accountId: "a1", label: "cuenta 1" }],
      }),
    /respondió 500/
  );
});
