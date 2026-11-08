// src/collectors/funnelOrganicCollector.ts
// Embudo orgánico de la app: lee la vista seo_funnel_daily de la BD de la app
// (APP_FUNNEL_DATABASE_URL, rol de solo lectura app_funnel_reader) y guarda los
// últimos 35 días en FunnelOrganicDaily. La vista ya agrupa por día de Madrid y
// no lleva ids, emails ni slugs; la página de entrada ya viene enmascarada.
import { PrismaClient } from "@prisma/client";
import { assertSafeDatabase, prisma } from "../db";
import { getEnv } from "../env";

// Ventana que se vuelve a leer cada día, hoy incluido: los eventos de días
// pasados cambian (reembolsos, cuentas excluidas después, sincronización tardía).
export const FUNNEL_DAYS_BACK = 35;
// Página de entrada cuando la cuenta no tiene origen guardado (NULL en la vista).
export const UNKNOWN_LANDING = "unknown";
const DEFAULT_STATEMENT_TIMEOUT_MS = 20_000;

export type FunnelViewRow = {
  day: string; // YYYY-MM-DD (Europe/Madrid)
  landingPath: string | null;
  channel: string;
  registros: number;
  bodasPublicadas: number;
  primerasConfirmaciones: number;
  pagos: number;
  revenueCents: number;
};

export type FetchFunnelRows = (range: { from: string; to: string }) => Promise<FunnelViewRow[]>;

/** Fecha de hoy (YYYY-MM-DD) en Europe/Madrid. */
export function madridDate(now: Date): string {
  // en-CA da el formato YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Resta días a una fecha YYYY-MM-DD (aritmética de calendario, sin horas). */
export function shiftIsoDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Ventana [from, to] de `daysBack` días que acaba hoy (Madrid). */
export function funnelWindow(now: Date, daysBack: number = FUNNEL_DAYS_BACK): { from: string; to: string } {
  const to = madridDate(now);
  return { from: shiftIsoDate(to, -(daysBack - 1)), to };
}

/**
 * Conexión aparte a la BD de la app: una sola conexión, timeout de conexión
 * corto, transacción de solo lectura y statement_timeout local. Aunque el rol ya
 * es de solo lectura, la sesión tampoco puede escribir.
 */
export async function withAppFunnelReader<T>(
  url: string,
  fn: (tx: Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">) => Promise<T>,
  opts: { statementTimeoutMs?: number } = {}
): Promise<T> {
  assertSafeDatabase(url);
  const timeoutMs = Math.max(1, Math.floor(opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  const parsed = new URL(url);
  if (!parsed.searchParams.has("connection_limit")) parsed.searchParams.set("connection_limit", "1");
  if (!parsed.searchParams.has("connect_timeout")) parsed.searchParams.set("connect_timeout", "10");

  const client = new PrismaClient({ datasourceUrl: parsed.toString() });
  try {
    return await client.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
        return fn(tx);
      },
      { timeout: timeoutMs + 10_000, maxWait: 15_000 }
    );
  } finally {
    await client.$disconnect();
  }
}

type RawViewRow = {
  day: string;
  landing_path: string | null;
  channel: string | null;
  registros: number | bigint | null;
  bodas_publicadas: number | bigint | null;
  primeras_confirmaciones: number | bigint | null;
  pagos: number | bigint | null;
  revenue_cents: number | bigint | null;
};

function toInt(value: number | bigint | null, column: string): number {
  const n = value === null ? 0 : Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > 2_147_483_647) {
    throw new Error(`seo_funnel_daily.${column} fuera de rango: ${String(value)}`);
  }
  return n;
}

/** Lector por defecto: la vista real con APP_FUNNEL_DATABASE_URL. */
export function appFunnelFetcher(
  url: string = getEnv("APP_FUNNEL_DATABASE_URL"),
  opts: { statementTimeoutMs?: number } = {}
): FetchFunnelRows {
  return ({ from, to }) =>
    withAppFunnelReader(
      url,
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<RawViewRow[]>(
          `SELECT day::text AS day, landing_path, channel, registros, bodas_publicadas,
                  primeras_confirmaciones, pagos, revenue_cents
             FROM seo_funnel_daily
            WHERE day BETWEEN $1::date AND $2::date`,
          from,
          to
        );
        return rows.map((r) => ({
          day: r.day,
          landingPath: r.landing_path,
          channel: r.channel ?? "sin datos",
          registros: toInt(r.registros, "registros"),
          bodasPublicadas: toInt(r.bodas_publicadas, "bodas_publicadas"),
          primerasConfirmaciones: toInt(r.primeras_confirmaciones, "primeras_confirmaciones"),
          pagos: toInt(r.pagos, "pagos"),
          revenueCents: toInt(r.revenue_cents, "revenue_cents"),
        }));
      },
      opts
    );
}

export async function collectFunnelOrganic(
  deps: { fetch?: FetchFunnelRows; now?: Date; daysBack?: number } = {}
): Promise<{ from: string; to: string; saved: number; removed: number; unknownLanding: number }> {
  const { from, to } = funnelWindow(deps.now ?? new Date(), deps.daysBack ?? FUNNEL_DAYS_BACK);
  const fetch = deps.fetch ?? appFunnelFetcher();
  const rows = await fetch({ from, to });

  // La vista agrupa por (día, landing, canal); se suma por si acaso para que
  // dos filas que caigan en la misma clave (NULL → 'unknown') no se pisen.
  const merged = new Map<string, Omit<FunnelViewRow, "landingPath"> & { landingPath: string }>();
  let unknownLanding = 0;
  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    const landingPath = row.landingPath?.trim() ? row.landingPath : UNKNOWN_LANDING;
    if (landingPath === UNKNOWN_LANDING) unknownLanding += 1;
    const id = `${row.day}\u0000${landingPath}\u0000${row.channel}`;
    const acc = merged.get(id);
    if (acc) {
      acc.registros += row.registros;
      acc.bodasPublicadas += row.bodasPublicadas;
      acc.primerasConfirmaciones += row.primerasConfirmaciones;
      acc.pagos += row.pagos;
      acc.revenueCents += row.revenueCents;
    } else {
      merged.set(id, { ...row, landingPath });
    }
  }

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);

  // Filas guardadas de la ventana que la vista ya no devuelve (p. ej. un pago
  // reembolsado o una cuenta excluida después): se borran para no dejar cifras
  // viejas. Si la vista no devuelve nada no se borra nada: es más probable una
  // BD equivocada que 35 días sin un solo registro.
  let staleIds: string[] = [];
  if (merged.size > 0) {
    const existing = await prisma.funnelOrganicDaily.findMany({
      where: { date: { gte: fromDate, lte: toDate } },
      select: { id: true, date: true, landingPath: true, channel: true },
    });
    staleIds = existing
      .filter((e) => !merged.has(`${e.date.toISOString().slice(0, 10)}\u0000${e.landingPath}\u0000${e.channel}`))
      .map((e) => e.id);
  }

  const upserts = [...merged.values()].map((r) => {
    const date = new Date(`${r.day}T00:00:00Z`);
    const metrics = {
      registros: r.registros,
      bodasPublicadas: r.bodasPublicadas,
      primerasConfirmaciones: r.primerasConfirmaciones,
      pagos: r.pagos,
      revenueCents: r.revenueCents,
    };
    return prisma.funnelOrganicDaily.upsert({
      where: { date_landingPath_channel: { date, landingPath: r.landingPath, channel: r.channel } },
      create: { date, landingPath: r.landingPath, channel: r.channel, ...metrics },
      update: metrics,
    });
  });

  await prisma.$transaction([
    ...(staleIds.length > 0 ? [prisma.funnelOrganicDaily.deleteMany({ where: { id: { in: staleIds } } })] : []),
    ...upserts,
  ]);

  return { from, to, saved: upserts.length, removed: staleIds.length, unknownLanding };
}
