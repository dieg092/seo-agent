// src/crawler/robotsTxt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRobotsTxt } from "./robotsTxt";

const UA = "miwebdeboda-seo-agent-crawler";

test("sin reglas se permite todo", () => {
  assert.equal(parseRobotsTxt("", UA).isAllowed("/blog"), true);
  assert.equal(parseRobotsTxt("User-agent: *\nDisallow:\n", UA).isAllowed("/blog"), true);
});

test("grupo * con Disallow por prefijo", () => {
  const p = parseRobotsTxt("User-agent: *\nDisallow: /admin\nDisallow: /api/\n", UA);
  assert.equal(p.isAllowed("/admin"), false);
  assert.equal(p.isAllowed("/admin/x"), false);
  assert.equal(p.isAllowed("/api/x"), false);
  assert.equal(p.isAllowed("/blog"), true);
});

test("gana la regla más larga y, a igualdad, Allow", () => {
  const p = parseRobotsTxt("User-agent: *\nDisallow: /blog\nAllow: /blog/guia\nDisallow: /x\nAllow: /x\n", UA);
  assert.equal(p.isAllowed("/blog/otra"), false);
  assert.equal(p.isAllowed("/blog/guia-boda"), true);
  assert.equal(p.isAllowed("/x"), true);
});

test("comodines * y $", () => {
  const p = parseRobotsTxt("User-agent: *\nDisallow: /*?page=\nDisallow: /*.json$\n", UA);
  assert.equal(p.isAllowed("/blog?page=2"), false);
  assert.equal(p.isAllowed("/datos.json"), false);
  assert.equal(p.isAllowed("/datos.json?x=1"), true);
  assert.equal(p.isAllowed("/blog"), true);
});

test("un grupo para nuestro agente tiene prioridad sobre *", () => {
  const text = [
    "User-agent: Googlebot",
    "Disallow: /blog",
    "",
    "User-agent: miwebdeboda-seo-agent",
    "User-agent: otro-bot",
    "Disallow: /precios # comentario",
    "",
    "User-agent: *",
    "Disallow: /",
  ].join("\n");
  const p = parseRobotsTxt(text, UA);
  assert.equal(p.isAllowed("/precios"), false);
  assert.equal(p.isAllowed("/blog"), true);
  // Sin grupo propio se usa el de *.
  assert.equal(parseRobotsTxt(text, "otro-crawler").isAllowed("/blog"), false);
});
