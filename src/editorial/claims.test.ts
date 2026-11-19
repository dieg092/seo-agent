// src/editorial/claims.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { figures, unsourcedNewFigures } from "./claims";

test("cifras: porcentajes, euros y «N de cada M», normalizadas", () => {
  assert.deepEqual(figures("El 40 % gasta 1.200 euros o 1500 €; 3 de cada 10 lo hacen; €500."), ["40%", "1.200€", "1500€", "3decada10", "€500"]);
});

test("cifras nuevas sin fuente; las de main y las enlazadas no cuentan", () => {
  const base = "El 40% de las parejas.";
  const head = "El 40% de las parejas.\n\nAhora el 55% lo hace.\n\nY 900 € según [el estudio](https://ejemplo.org/x).";
  assert.deepEqual(unsourcedNewFigures(base, head).map((u) => u.figure), ["55%"]);
  assert.deepEqual(unsourcedNewFigures(head, head), []);
});
