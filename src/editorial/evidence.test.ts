// src/editorial/evidence.test.ts (sin BD)
import { test } from "node:test";
import assert from "node:assert/strict";
import { admittingFact, factsFromBank, factsFromPage, factsFromWeddingRows, factsForPrompt, productFacts, renderFactsForPrompt } from "./evidence";
import { deterministicBlock } from "./paired";
import { BASE_ARTICLE, BATTERY_CASES, BATTERY_FACTS } from "./fixtures/validationCases";

const BANK = `## Precios
| Concepto | Rango orientativo | Fuente | Verificado | Usos |
|---|---|---|---|---|
| Catering por persona (menú boda, calidad media) | 80-120 €/pax | Mesalia Catering — guía 2026 (cita: "Por invitado | 60 – 150 €") | Verificado 2026-07 | 2 |
| Hora extra en finca | 300–600 €/hora | Sector eventos España | Verificado 2026-05 | 1 |
| Alquiler de carpa | 300-3.000 € según tamaño. NO usar "3.000-5.000€ extra" | boda.es | Verificado 2026-07 | 0 |
| Presupuesto medio | 18.000–25.000 € | Bodas.net | Pendiente verificar año | 0 |
`;

test("banco: solo filas verificadas y sin «NO usar»; la cita es el nombre o el dominio de la fuente", () => {
  const f = factsFromBank(BANK);
  assert.equal(f.length, 2);
  const cat = f[0];
  assert.ok(cat.forms.includes("120€"));
  const p = "El menú de calidad media cuesta entre 80 y 120 € por invitado en el catering, según Mesalia Catering.";
  assert.ok(admittingFact(p, "120€", f), "con el nombre de la fuente");
  assert.ok(admittingFact("Un catering de calidad media cuesta unos 120 € por persona ([guía de Mesalia](https://mesalia.es/x)).", "120€", f), "la marca sola también vale");
  assert.equal(admittingFact("El catering de calidad media cuesta unos 120 € por persona.", "120€", f), null, "sin cita no");
  assert.equal(admittingFact("El fotógrafo cuesta 120 €, según Mesalia Catering.", "120€", f), null, "otro tema no");
  assert.equal(admittingFact("La hora extra en la finca cuesta 600 €, según el sector.", "600€", f), null, "una fuente genérica no se puede citar por nombre");
});

test("propio: ≥ 30 bodas, se atribuye a miwebdeboda y casa el tema; «N de cada 10» y semanas también valen", () => {
  const f = factsFromWeddingRows([
    { metric: "alergia_alguna_pct", value: 19.6, unit: "%", n_bodas: 41, n_registros: 4000, desde: "2025-05-01", hasta: "2026-10-31" },
    { metric: "limite_antes_boda_dias_mediana", value: 42, unit: "días", n_bodas: 41, n_registros: 41, desde: null, hasta: null },
    { metric: "mes:09", value: 30.2, unit: "%", n_bodas: 12, n_registros: 12, desde: null, hasta: null },
    { metric: "desconocida", value: 3, unit: "%", n_bodas: 50, n_registros: 50, desde: null, hasta: null },
  ]);
  assert.equal(f.length, 2, "menos de 30 bodas o métrica desconocida: fuera");
  const ok = "En las bodas que se organizan con miwebdeboda, dos de cada diez invitados declaran alguna alergia.";
  assert.ok(admittingFact(ok, "dosdecadadiez", f));
  assert.ok(admittingFact("En miwebdeboda, el 19,6 % de los invitados avisa de una alergia.", "19,6%", f));
  assert.equal(admittingFact("El 20 % de los invitados avisa de una alergia.", "20%", f), null, "sin atribuir");
  assert.ok(admittingFact("Con miwebdeboda, la fecha límite se pone de media 6 semanas antes.", "6semanas", f));
});

test("web: frases con cifra de una página de datos; se citan enlazando la página o la fuente", () => {
  const f = factsFromPage("/estadisticas-bodas/espana", "El INE registró 175.364 matrimonios en 2024, un 1,7% más que en 2023. Según el INE, septiembre concentra alrededor del 17% de las bodas. El 15% de los invitados confirma en las últimas dos semanas.", ["ine.es"]);
  assert.equal(f.length, 2, "la frase sin organismo oficial no entra");
  assert.ok(admittingFact("Septiembre concentra cerca del 17% de las bodas ([datos](/estadisticas-bodas/espana)).", "17%", f));
  assert.ok(admittingFact("El INE registró en 2024 un 1,7% más de matrimonios que el año anterior.", "1,7%", f));
  assert.equal(admittingFact("Septiembre concentra el 17% de las bodas ([otra](/blog/x)).", "17%", f), null);
});

test("producto: solo los 49 € de la Básica, enlazando /precios o nombrando miwebdeboda", () => {
  assert.ok(admittingFact("El Premium básico cuesta 49 € ([ver precios](/precios)).", "49€", productFacts()));
  assert.equal(admittingFact("El plan de autor cuesta 119 € ([ver precios](/precios)).", "119€", productFacts()), null);
});

test("la guarda deja pasar un dato admitido bien citado y bloquea los mal usados de la batería", () => {
  const good = `${BASE_ARTICLE}\n## Menús especiales\n\nEn las bodas que se organizan con miwebdeboda, el 12 % de los invitados que asisten pide menú vegetariano: avisad al catering con tiempo.\n`;
  assert.equal(deterministicBlock(BASE_ARTICLE, good, "x", BATTERY_FACTS), null);
  for (const id of ["cifra-admitida-sin-cita", "cifra-admitida-otro-tema"]) {
    const c = BATTERY_CASES.find((x) => x.id === id)!;
    assert.match(deterministicBlock(BASE_ARTICLE, c.head, id, BATTERY_FACTS) ?? "", /bloquea/);
  }
  assert.match(deterministicBlock(BASE_ARTICLE, good, "x", []) ?? "", /bloquea/, "sin catálogo, ninguna cifra nueva");
});

test("prompt: los datos del tema primero, con cómo citarlos", () => {
  const facts = [...factsFromBank(BANK), ...BATTERY_FACTS, ...productFacts()];
  const top = factsForPrompt("menú vegetariano para invitados con dieta especial", facts, 2);
  assert.equal(top[0].kind, "propio");
  const txt = renderFactsForPrompt(top);
  assert.match(txt, /ÚNICAS cifras nuevas/);
  assert.match(txt, /atribúyelo a miwebdeboda/);
});
