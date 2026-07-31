import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFetchStartDate } from "./computeFetchStartDate";

const TODAY = new Date("2026-07-31T00:00:00.000Z");

test("sin huecos, usa la ventana móvil normal (today - daysBack)", () => {
  const existingDates = new Set<string>();
  for (let i = 3; i <= 30; i++) {
    const d = new Date(TODAY);
    d.setUTCDate(d.getUTCDate() - i);
    existingDates.add(d.toISOString().slice(0, 10));
  }

  const result = computeFetchStartDate({
    existingDates,
    today: TODAY,
    daysBack: 3,
    lookbackWindowDays: 30,
  });

  assert.equal(result, "2026-07-28"); // today - 3
});

test("con un hueco de un solo día, retrocede el startDate hasta ese día", () => {
  const existingDates = new Set<string>();
  for (let i = 3; i <= 30; i++) {
    if (i === 10) continue; // hueco: falta 2026-07-21
    const d = new Date(TODAY);
    d.setUTCDate(d.getUTCDate() - i);
    existingDates.add(d.toISOString().slice(0, 10));
  }

  const result = computeFetchStartDate({
    existingDates,
    today: TODAY,
    daysBack: 3,
    lookbackWindowDays: 30,
  });

  assert.equal(result, "2026-07-21"); // today - 10
});

test("con varios huecos, retrocede hasta el más antiguo del rango", () => {
  const existingDates = new Set<string>();
  for (let i = 3; i <= 30; i++) {
    if (i === 5 || i === 20) continue; // huecos en dos días distintos
    const d = new Date(TODAY);
    d.setUTCDate(d.getUTCDate() - i);
    existingDates.add(d.toISOString().slice(0, 10));
  }

  const result = computeFetchStartDate({
    existingDates,
    today: TODAY,
    daysBack: 3,
    lookbackWindowDays: 30,
  });

  assert.equal(result, "2026-07-11"); // today - 20, el más antiguo de los dos huecos
});

test("un día sin datos fuera de la ventana de lookback no se cuenta como hueco", () => {
  const existingDates = new Set<string>();
  for (let i = 3; i <= 30; i++) {
    const d = new Date(TODAY);
    d.setUTCDate(d.getUTCDate() - i);
    existingDates.add(d.toISOString().slice(0, 10));
  }
  // día 31 (fuera de la ventana de 30) no tiene datos, pero no debe importar

  const result = computeFetchStartDate({
    existingDates,
    today: TODAY,
    daysBack: 3,
    lookbackWindowDays: 30,
  });

  assert.equal(result, "2026-07-28"); // sigue siendo la ventana normal
});

test("nunca retrocede a menos de daysBack (respeta el lag de la API de GSC)", () => {
  const existingDates = new Set<string>(); // todo vacío, huecos por todas partes

  const result = computeFetchStartDate({
    existingDates,
    today: TODAY,
    daysBack: 3,
    lookbackWindowDays: 30,
  });

  assert.equal(result, "2026-07-01"); // today - 30, el límite más antiguo de la ventana
});
