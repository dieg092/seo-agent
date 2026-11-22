// scripts/communities-connect.ts — lo ejecuta el fundador una vez por cuenta:
//   pnpm comunidades:telegram   (inicia sesión en Telegram, solo lectura)
//   pnpm comunidades:gmail      (Gmail por IMAP con una contraseña de aplicación)
// Guarda las credenciales en ~/.comunidades/*.json (600), comprueba que funcionan y activa la fuente.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { prisma } from "../src/db";
import { ACCOUNTS_DIR, GMAIL_FILE, TELEGRAM_FILE } from "../src/communities/accounts";

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const rlAny = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
      rlAny._writeToOutput = (s: string) => {
        if (s.includes(question)) rlAny.output.write(s);
        else rlAny.output.write("*".repeat(s.length > 2 ? 0 : s.length));
      };
    }
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a.trim());
    });
  });
}

function save(file: string, data: object) {
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function enable(kind: string, note: string) {
  await prisma.communitySource.update({ where: { kind }, data: { enabled: true, status: "ready", note, lastAttemptAt: null, lastErrorCode: null } });
}

async function connectTelegram() {
  console.log("1) Entra en https://my.telegram.org → «API development tools» y crea una app (nombre y descripción cualquiera).");
  const apiId = Number(await ask("api_id: "));
  const apiHash = await ask("api_hash: ", true);
  const { TelegramClient } = await import("teleproto");
  const { StringSession } = await import("teleproto/sessions");
  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 3 });
  await client.start({
    phoneNumber: () => ask("Tu teléfono con prefijo (+34…): "),
    phoneCode: () => ask("Código que te ha llegado a Telegram: "),
    password: () => ask("Contraseña de verificación en dos pasos (si no tienes, Enter): ", true),
    onError: (e) => console.error("Telegram:", e.message),
  });
  save(TELEGRAM_FILE, { apiId, apiHash, session: (client.session as InstanceType<typeof StringSession>).save() });
  await client.disconnect();
  await enable("telegram", "Lee los grupos públicos de bodas a los que estés unido");
  console.log("Telegram conectado. El agente leerá solo los grupos públicos de bodas a los que te unas.");
}

async function connectGmail() {
  console.log("1) Entra en https://myaccount.google.com/apppasswords, crea una contraseña de aplicación llamada «comunidades» y cópiala.");
  const user = await ask("Tu dirección de Gmail: ");
  const appPassword = (await ask("Contraseña de aplicación (16 letras): ", true)).replace(/\s+/g, "");
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass: appPassword }, logger: false });
  await client.connect();
  await client.logout();
  save(GMAIL_FILE, { user, appPassword });
  await enable("facebook_email", "Lee de tu Gmail las notificaciones de grupos de Facebook (solo lectura)");
  console.log("Gmail conectado. Activa en cada grupo de Facebook las notificaciones por correo de las publicaciones nuevas.");
}

const which = process.argv[2];
(which === "telegram" ? connectTelegram() : which === "gmail" ? connectGmail() : Promise.reject(new Error("uso: telegram | gmail")))
  .catch((e) => {
    console.error("No se pudo conectar:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
