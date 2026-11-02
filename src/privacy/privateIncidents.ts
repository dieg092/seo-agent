// Incidentes de páginas privadas expuestas (§10.7 y §13.1 de la spec).
// En la fase 1, `private-page-exposed` solo deja una fila en PrivateIncident (con la URL
// real cifrada) y una alerta (BD y Telegram). El freno automático llega en la fase 4.
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import { encryptUrl, hmac12, requirePrivateUrlKey } from "./redact";

/**
 * Guarda o reabre el incidente de una URL privada, identificado por su HMAC.
 * `isNew` es true si no existía o si estaba resuelto (se reabre): es cuando hay que avisar.
 */
export async function upsertPrivateIncident(
  url: string,
  source: string,
  opts: { key?: string; now?: Date } = {}
): Promise<{ isNew: boolean; urlHmac: string }> {
  const key = requirePrivateUrlKey(opts.key);
  const now = opts.now ?? new Date();
  const urlHmac = hmac12(url, key);

  const existing = await prisma.privateIncident.findUnique({ where: { urlHmac } });
  if (!existing) {
    await prisma.privateIncident.create({
      data: { urlHmac, urlEncrypted: encryptUrl(url, key), firstSeenAt: now, lastSeenAt: now, sources: [source] },
    });
    return { isNew: true, urlHmac };
  }

  await prisma.privateIncident.update({
    where: { urlHmac },
    data: {
      lastSeenAt: now,
      sources: existing.sources.includes(source) ? existing.sources : [...existing.sources, source],
      resolvedAt: null,
    },
  });
  return { isNew: existing.resolvedAt !== null, urlHmac };
}

/**
 * Registra una URL privada expuesta y avisa solo si el incidente es nuevo o estaba resuelto.
 * El aviso nunca lleva la URL real: solo el hmac y el origen.
 */
export async function recordPrivateExposure(
  url: string,
  source: string,
  deps: { alert?: typeof recordAlert; now?: Date } = {}
): Promise<{ isNew: boolean }> {
  const alert = deps.alert ?? recordAlert;
  const { isNew, urlHmac } = await upsertPrivateIncident(url, source, { now: deps.now });
  if (isNew) {
    await alert({
      type: "private-page-exposed",
      subject: "Página privada expuesta",
      body: `<privada:${urlHmac}> (${source}). La URL real está cifrada en PrivateIncident.`,
    });
  }
  return { isNew };
}
