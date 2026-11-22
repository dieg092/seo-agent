// scripts/communities-connect.ts — lo ejecuta el fundador una vez por cuenta:
//   pnpm comunidades:gmail      (Gmail por IMAP con una contraseña de aplicación)
//   pnpm comunidades:apify      (token de la cuenta gratuita de Apify SOLO para comunidades)
// Guarda las credenciales en ~/.comunidades/*.json (600), comprueba que funcionan y activa la fuente.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { prisma } from "../src/db";
import { ACCOUNTS_DIR, APIFY_FILE, GMAIL_FILE } from "../src/communities/accounts";

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
  // Las contraseñas de aplicación son 16 letras; al pegar pueden colarse espacios o códigos de la terminal.
  const appPassword = (await ask("Contraseña de aplicación (16 letras): ", true)).replace(/[^a-zA-Z]/g, "");
  if (appPassword.length !== 16) throw new Error(`la contraseña tiene ${appPassword.length} letras y deben ser 16; vuelve a copiarla`);
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass: appPassword }, logger: false });
  try {
    await client.connect();
  } catch (e: any) {
    // Sin la contraseña: solo el código y el texto de respuesta del servidor.
    if (e?.authenticationFailed) throw new Error(`Gmail rechaza el usuario o la contraseña (${e.serverResponseCode ?? "AUTHENTICATIONFAILED"}). Comprueba que la contraseña de aplicación es de esta misma cuenta.`);
    throw new Error(`${e?.message ?? e}${e?.responseText ? ` (${e.responseText})` : ""}${e?.code ? ` [${e.code}]` : ""}`);
  }
  await client.logout();
  save(GMAIL_FILE, { user, appPassword });
  await enable("facebook_email", "Lee de tu Gmail las notificaciones de grupos de Facebook (solo lectura)");
  console.log("Gmail conectado. Activa en cada grupo de Facebook las notificaciones por correo de las publicaciones nuevas.");
}

async function connectApify() {
  console.log("1) En https://console.apify.com/settings/integrations copia el «Personal API token» de la cuenta de comunidades (no la de colaboradores).");
  const token = (await ask("Token de Apify: ", true)).replace(/\s+/g, "");
  const r = await fetch("https://api.apify.com/v2/users/me", { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Apify rechaza el token (${r.status})`);
  const me: any = (await r.json()).data;
  save(APIFY_FILE, { token });
  await prisma.communitySource.upsert({
    where: { kind: "tiktok" },
    create: { kind: "tiktok", enabled: true, status: "ready", note: "TikTok con la cuenta gratuita de Apify (tope 4 $/mes)" },
    update: { enabled: true, status: "ready", note: "TikTok con la cuenta gratuita de Apify (tope 4 $/mes)", lastAttemptAt: null, lastErrorCode: null },
  });
  console.log(`Apify conectado (usuario ${me?.username ?? "?"}, plan ${me?.plan?.id ?? "?"}). TikTok hará una búsqueda al día con tope de 4 $ al mes.`);
}

const which = process.argv[2];
(which === "gmail" ? connectGmail() : which === "apify" ? connectApify() : Promise.reject(new Error("uso: gmail | apify")))
  .catch((e) => {
    console.error("No se pudo conectar:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
