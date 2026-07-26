// src/alerts/sendTelegramMessage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTelegramMessage } from "./sendTelegramMessage";

test("sendTelegramMessage skips silently when env vars are missing", async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  let called = false;
  await sendTelegramMessage("hello", {
    fetchImpl: (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });

  assert.equal(called, false);

  if (originalToken) process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChatId) process.env.TELEGRAM_CHAT_ID = originalChatId;
});

test("sendTelegramMessage posts to the Telegram Bot API when configured", async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "12345";

  let calledUrl: string | undefined;
  let calledBody: string | undefined;
  await sendTelegramMessage("hello", {
    fetchImpl: (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledBody = init.body as string;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch,
  });

  assert.equal(calledUrl, "https://api.telegram.org/bottest-token/sendMessage");
  assert.deepEqual(JSON.parse(calledBody!), { chat_id: "12345", text: "hello", parse_mode: "HTML" });

  if (originalToken) process.env.TELEGRAM_BOT_TOKEN = originalToken;
  else delete process.env.TELEGRAM_BOT_TOKEN;
  if (originalChatId) process.env.TELEGRAM_CHAT_ID = originalChatId;
  else delete process.env.TELEGRAM_CHAT_ID;
});

test("sendTelegramMessage throws when the Telegram API responds with an error", async () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "12345";

  await assert.rejects(
    sendTelegramMessage("hello", {
      fetchImpl: (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch,
    }),
  );

  if (originalToken) process.env.TELEGRAM_BOT_TOKEN = originalToken;
  else delete process.env.TELEGRAM_BOT_TOKEN;
  if (originalChatId) process.env.TELEGRAM_CHAT_ID = originalChatId;
  else delete process.env.TELEGRAM_CHAT_ID;
});
