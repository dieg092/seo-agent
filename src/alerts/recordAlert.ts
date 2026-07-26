// src/alerts/recordAlert.ts
import { prisma } from "../db";
import { sendTelegramMessage } from "./sendTelegramMessage";

export async function recordAlert(deps: {
  type: string;
  subject: string;
  body: string;
  notify?: typeof sendTelegramMessage;
}): Promise<void> {
  const notify = deps.notify ?? sendTelegramMessage;

  await prisma.alert.create({
    data: {
      type: deps.type,
      subject: deps.subject,
      body: deps.body,
    },
  });

  // Alerts used to only land in the DB, which nobody was checking — a failure
  // could sit there unacknowledged for weeks. Push it to Telegram too, but
  // never let a Telegram outage turn a recorded alert into a thrown error.
  try {
    await notify(`🚨 <b>${deps.subject}</b>\n${deps.body}`);
  } catch (error) {
    console.error("No se pudo enviar el aviso de Telegram (no bloqueante):", error);
  }
}
