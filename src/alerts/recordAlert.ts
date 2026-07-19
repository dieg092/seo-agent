// src/alerts/recordAlert.ts
import { prisma } from "../db";

export async function recordAlert(deps: {
  type: string;
  subject: string;
  body: string;
}): Promise<void> {
  await prisma.alert.create({
    data: {
      type: deps.type,
      subject: deps.subject,
      body: deps.body,
    },
  });
}
