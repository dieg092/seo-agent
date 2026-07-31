// Decide qué startDate pedir a la API de Search Console. Sin esto, el
// collector siempre pedía un rango móvil fijo de `daysBack` días — si el
// cron diario fallaba un día (p. ej. por el watchdog en fallo, T05), ese
// día quedaba perdido para siempre en SearchConsoleSnapshot, sin ningún
// mecanismo que lo recuperara después (hallazgo T02 de la auditoría
// SEO/growth de wedding-invite-2, 2026-07-31).
//
// Busca huecos (días sin ninguna fila) dentro de una ventana de
// `lookbackWindowDays`, excluyendo siempre los `daysBack` días más
// recientes (la API de GSC tiene ~2-3 días de lag y no tendría datos
// ahí todavía). Si hay algún hueco, retrocede el startDate hasta el más
// antiguo encontrado — como el upsert es idempotente por (date, page,
// query), pedir de más nunca duplica datos, solo los re-confirma.
export function computeFetchStartDate(params: {
  existingDates: Set<string>;
  today: Date;
  daysBack: number;
  lookbackWindowDays: number;
}): string {
  const { existingDates, today, daysBack, lookbackWindowDays } = params;

  let earliestMissing: string | null = null;
  for (let i = lookbackWindowDays; i >= daysBack; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if (!existingDates.has(iso)) {
      earliestMissing = iso;
      break;
    }
  }

  if (earliestMissing) return earliestMissing;

  const normalStart = new Date(today);
  normalStart.setUTCDate(normalStart.getUTCDate() - daysBack);
  return normalStart.toISOString().slice(0, 10);
}
