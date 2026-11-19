// src/editorial/evidenceStore.test.ts (BD de pruebas)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { loadFacts, refreshEvidence, type EvidenceDeps } from "./evidenceStore";

const NOW = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400_000;
const BANK = `| Concepto | Rango | Fuente | Verificado | Usos |\n|---|---|---|---|---|\n| Catering por persona | 80-120 €/pax | Mesalia Catering | Verificado 2026-07 | 1 |\n`;
const PAGE = `<html><body><article><p>El INE registró 175.364 matrimonios en 2024, un 1,7% más que en 2023.</p><a href="https://www.ine.es/x">INE</a></article></body></html>`;
const deps = (o: Partial<EvidenceDeps> = {}): EvidenceDeps => ({
  readBank: async () => BANK,
  dataPages: async () => [{ path: "/estadisticas-bodas/espana", html: PAGE }],
  weddingRows: async () => [{ metric: "dieta:vegetariana", value: 12, unit: "%", n_bodas: 40, n_registros: 3000, desde: "2025-05-01", hasta: "2026-10-31" }],
  ...o,
});

beforeEach(async () => {
  await prisma.editorialFact.deleteMany({});
});

test("refresca las cuatro fuentes, una vez al día, y el catálogo caduca a los 14 días", async () => {
  const note = await refreshEvidence(NOW, deps());
  assert.match(note, /producto 1, banco 1, web 1, propio 1/);
  assert.equal((await loadFacts(NOW)).length, 4);
  assert.equal(await refreshEvidence(new Date(NOW.getTime() + 3600_000), deps()), "", "antes de 24 h no se repite");
  assert.equal((await loadFacts(new Date(NOW.getTime() + 15 * DAY))).length, 0, "sin refrescar en 14 días: ninguna cifra nueva");
});

test("una fuente que falla no toca las demás ni borra lo suyo; un dato que desaparece deja de valer", async () => {
  await refreshEvidence(NOW, deps());
  const later = new Date(NOW.getTime() + 2 * DAY);
  const note = await refreshEvidence(later, deps({ readBank: async () => { throw new Error("git caído"); }, weddingRows: async () => [] }));
  assert.match(note, /banco sin refrescar \(git caído\)/);
  const facts = await loadFacts(later);
  assert.ok(facts.some((f) => f.kind === "banco"), "el banco anterior sigue (caducará solo)");
  assert.ok(!facts.some((f) => f.kind === "propio"), "la vista ya no da el dato: fuera");
});
