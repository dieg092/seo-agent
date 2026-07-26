// src/alerts/recordAlert.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { recordAlert } from "./recordAlert";

test("recordAlert creates an unacknowledged Alert row with the given type/subject/body", async () => {
  await recordAlert({ type: "negative-impact", subject: "Test subject", body: "Test body" });

  const alert = await prisma.alert.findFirst({
    where: { subject: "Test subject" },
    orderBy: { createdAt: "desc" },
  });

  assert.ok(alert);
  assert.equal(alert?.type, "negative-impact");
  assert.equal(alert?.body, "Test body");
  assert.equal(alert?.acknowledged, false);

  await prisma.alert.delete({ where: { id: alert!.id } });
});

test("recordAlert notifies Telegram with the subject/body and never throws if that fails", async () => {
  let notifiedText: string | undefined;
  await recordAlert({
    type: "negative-impact",
    subject: "Telegram subject",
    body: "Telegram body",
    notify: async (text) => {
      notifiedText = text;
      throw new Error("Telegram is down");
    },
  });

  assert.match(notifiedText!, /Telegram subject/);
  assert.match(notifiedText!, /Telegram body/);

  await prisma.alert.deleteMany({ where: { subject: "Telegram subject" } });
});
