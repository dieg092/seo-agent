// src/collectors/analyticsLandingCollector.ts
// GA4 por página de entrada: sesiones, sesiones con interacción y eventos clave por
// día, landing y canal, en AnalyticsLandingDaily. Las landings privadas (webs de las
// parejas, invitaciones con token, rutas de sesión) se guardan redactadas con HMAC.
import { prisma } from "../db";
import { getEnv } from "../env";
import { fetchLandingRows } from "../google/analyticsClient";
import { classifyPath, normalizeUrl, SITE_ORIGIN } from "../privacy/sitePrivacy";
import { hmac12, requirePrivateUrlKey } from "../privacy/redact";

function isoDateDaysAgo(today: Date, daysAgo: number): string {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Convierte la landing de GA4 en lo que se guarda:
 * - los valores especiales de GA4 (`(not set)`, `(other)`) se guardan tal cual;
 * - las rutas públicas, como URL normalizada (igual que las páginas de GSC);
 * - las privadas, según classifyPath, como `https://miwebdeboda.com/<privada:{hmac12}>`.
 */
export function landingForStorage(landingPage: string, key: string): string {
  const raw = landingPage.trim();
  if (raw.startsWith("(")) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  if (classifyPath(path) !== "public") return `${SITE_ORIGIN}/<privada:${hmac12(path, key)}>`;
  return normalizeUrl(path);
}

export async function collectAnalyticsLanding(
  deps: {
    fetch?: typeof fetchLandingRows;
    today?: Date;
    daysBack?: number;
  } = {}
): Promise<{ saved: number; privateLandings: number; metric: "keyEvents" | "conversions" }> {
  // Sin clave no se pide ni se escribe nada: nunca se guarda una landing en claro.
  const key = requirePrivateUrlKey();
  const fetch = deps.fetch ?? fetchLandingRows;
  const today = deps.today ?? new Date();
  const daysBack = deps.daysBack ?? 3;

  const { rows, metric } = await fetch({
    propertyId: getEnv("GA4_PROPERTY_ID"),
    startDate: isoDateDaysAgo(today, daysBack),
    endDate: isoDateDaysAgo(today, 0),
  });

  // Tras normalizar o redactar, dos filas de GA4 pueden caer en la misma clave
  // (por ejemplo `/blog/x` y `/blog/x/`): se suman antes de guardar.
  const merged = new Map<
    string,
    { date: string; landingPage: string; channel: string; sessions: number; engagedSessions: number; keyEvents: number }
  >();
  let privateLandings = 0;
  for (const row of rows) {
    const landingPage = landingForStorage(row.landingPage, key);
    if (landingPage.includes("<privada:")) privateLandings += 1;
    const id = `${row.date}\u0000${landingPage}\u0000${row.channel}`;
    const acc = merged.get(id);
    if (acc) {
      acc.sessions += row.sessions;
      acc.engagedSessions += row.engagedSessions;
      acc.keyEvents += row.keyEvents;
    } else {
      merged.set(id, {
        date: row.date,
        landingPage,
        channel: row.channel,
        sessions: row.sessions,
        engagedSessions: row.engagedSessions,
        keyEvents: row.keyEvents,
      });
    }
  }

  let saved = 0;
  for (const r of merged.values()) {
    const date = new Date(r.date);
    const metrics = { sessions: r.sessions, engagedSessions: r.engagedSessions, keyEvents: r.keyEvents };
    await prisma.analyticsLandingDaily.upsert({
      where: { date_landingPage_channel: { date, landingPage: r.landingPage, channel: r.channel } },
      create: { date, landingPage: r.landingPage, channel: r.channel, ...metrics },
      update: metrics,
    });
    saved += 1;
  }

  return { saved, privateLandings, metric };
}
