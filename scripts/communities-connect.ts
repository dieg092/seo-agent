// scripts/communities-connect.ts — lo ejecuta el fundador una vez por cuenta:
//   pnpm comunidades:gmail      (Gmail por IMAP con una contraseña de aplicación)
// Guarda las credenciales en ~/.comunidades/*.json (600), comprueba que funcionan y activa la fuente.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { prisma } from "../src/db";
import { ACCOUNTS_DIR, GMAIL_FILE } from "../src/communities/accounts";

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
(which === "gmail" ? connectGmail() : Promise.reject(new Error("uso: gmail")))
  .catch((e) => {
    console.error("No se pudo conectar:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
