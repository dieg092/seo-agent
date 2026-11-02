import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPath, classifyUrl, isPrivateUrl, normalizeUrl } from "./sitePrivacy";

test("classifyPath: rutas publicas", () => {
  assert.equal(classifyPath("/blog/x"), "public");
  assert.equal(classifyPath("/colaboraciones/x"), "public");
  assert.equal(classifyPath("/"), "public");
  assert.equal(classifyPath(""), "public");
  assert.equal(classifyPath("/profesionales/fotografos/provincia/madrid"), "public");
  assert.equal(classifyPath("/precios/"), "public");
});

test("classifyPath: web de pareja e invitacion", () => {
  assert.equal(classifyPath("/ana-y-luis"), "private-unlisted");
  assert.equal(classifyPath("/ana-y-luis/"), "private-unlisted");
  assert.equal(classifyPath("/ana-y-luis/i/abc"), "private-token");
  assert.equal(classifyPath("/dominio-propio/ejemplo.com"), "private-unlisted");
});

test("classifyPath: rutas de sesion", () => {
  assert.equal(classifyPath("/admin/cuenta"), "private-session");
  assert.equal(classifyPath("/api/algo"), "private-session");
  assert.equal(classifyPath("/login?next=/admin"), "private-session");
  assert.equal(classifyPath("/colaboraciones/x/participar"), "private-session");
});

test("classifyUrl: otro host es dominio propio", () => {
  assert.equal(classifyUrl("https://boda-de-prueba.example/"), "private-unlisted");
  assert.equal(classifyUrl("https://www.miwebdeboda.com/blog"), "public");
  assert.equal(isPrivateUrl("https://miwebdeboda.com/ana-y-luis"), true);
  assert.equal(isPrivateUrl("https://miwebdeboda.com/blog/x"), false);
});

test("normalizeUrl: https, host en minusculas y sin barra final", () => {
  assert.equal(normalizeUrl("http://MiWebDeBoda.com/blog/x/"), "https://miwebdeboda.com/blog/x");
  assert.equal(normalizeUrl("https://www.miwebdeboda.com/blog/x#a"), "https://miwebdeboda.com/blog/x");
  assert.equal(normalizeUrl("/blog/x"), "https://miwebdeboda.com/blog/x");
});

test("normalizeUrl: la raiz conserva la barra", () => {
  assert.equal(normalizeUrl("https://miwebdeboda.com"), "https://miwebdeboda.com/");
  assert.equal(normalizeUrl("http://MIWEBDEBODA.com/"), "https://miwebdeboda.com/");
});
