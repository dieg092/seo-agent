// src/collectors/brand.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBrandQuery } from "./brand";

test('isBrandQuery("mi web de boda precios") es true', () => {
  assert.equal(isBrandQuery("mi web de boda precios"), true);
});

test("isBrandQuery reconoce las variantes de la marca", () => {
  assert.equal(isBrandQuery("miwebdeboda"), true);
  assert.equal(isBrandQuery("MiWebDeBoda opiniones"), true);
  assert.equal(isBrandQuery("mi  webde boda"), true);
  assert.equal(isBrandQuery("mwdb login"), true);
});

test("isBrandQuery no marca consultas genericas", () => {
  assert.equal(isBrandQuery("web de boda gratis"), false);
  assert.equal(isBrandQuery("invitacion digital boda"), false);
});
