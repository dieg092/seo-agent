// src/strategy/intentSignals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractIntentMismatchFindings, extractSeasonalFindings, MAX_SEASONAL_FINDINGS } from "./intentSignals";

test("intención que no encaja: buena posición, casi sin clics y sin interacción", () => {
  const base = { page: "https://miwebdeboda.com/blog/a/b", impressions: 1000, clicks: 5, position: 3, sessions: 40, engagedSessions: 10 };
  const f = extractIntentMismatchFindings([
    base,
    { ...base, page: "p-interactua", engagedSessions: 30 },
    { ...base, page: "p-clica", clicks: 200 },
    { ...base, page: "p-lejos", position: 9 },
    { ...base, page: "p-pocas", impressions: 100 },
    { ...base, page: "p-sin-ga", sessions: 5 },
  ]);
  assert.deepEqual(f.map((x) => x.sourceRefId), [base.page]);
  assert.equal(f[0].findingType, "content-intent-mismatch");
  assert.match(f[0].title, /25% de interacción/);
});

test("estacional: solo con más de 13 meses de datos y un pico doble el año pasado", () => {
  const now = new Date("2027-11-18T00:00:00Z");
  const day = (offsetFromNow: number) => new Date(now.getTime() - offsetFromNow * 86400_000);
  const rows = [];
  // «boda navidad»: 10/día todo el año y 40/día en los próximos 60 días del año pasado.
  for (let d = 305; d < 670; d++) rows.push({ date: day(d), query: "boda navidad", page: "/blog/x/navidad", impressions: d < 365 ? 40 : 10 });
  // «web de boda»: plana.
  for (let d = 305; d < 670; d++) rows.push({ date: day(d), query: "web de boda", page: "/", impressions: 20 });
  const f = extractSeasonalFindings(rows, day(700), now);
  assert.deepEqual(f.map((x) => x.sourceRefId), ["boda navidad"]);
  assert.equal((f[0].detail as { page: string }).page, "/blog/x/navidad");
  assert.deepEqual(extractSeasonalFindings(rows, day(200), now), [], "sin un año de histórico no dice nada");
  assert.ok(MAX_SEASONAL_FINDINGS <= 5);
});
