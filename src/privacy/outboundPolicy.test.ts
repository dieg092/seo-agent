// src/privacy/outboundPolicy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, redactValue, containsPrivate, REDACTED } from "./outboundPolicy";
import { buildContract, renderPrompt, taskTitle } from "../bridge/contract";

const CANARIO = "canario-privado-7f3a";

test("texto libre: URLs y rutas privadas fuera, públicas y ajenas intactas", () => {
  const t = redactText(
    `Mira https://miwebdeboda.com/${CANARIO} y /${CANARIO}/i/tok123, también miwebdeboda.com/${CANARIO}. ` +
      "Pública: https://miwebdeboda.com/blog/organizar-boda/after-party y /precios. Fuente: https://www.boe.es/x.",
  );
  assert.ok(!t.includes(CANARIO), t);
  assert.equal(t.split(REDACTED).length - 1, 3);
  assert.ok(t.includes("https://miwebdeboda.com/blog/organizar-boda/after-party"));
  assert.ok(t.includes("/precios"));
  assert.ok(t.includes("https://www.boe.es/x"));
});

test("la portada con puntuación detrás no es privada y redactar dos veces da lo mismo", () => {
  const t = "desde 2 páginas: https://miwebdeboda.com/, https://miwebdeboda.com/blog/a/b y miwebdeboda.com.";
  assert.equal(redactText(t), t);
  const p = redactText(`https://miwebdeboda.com/${CANARIO}, https://miwebdeboda.com/blog/a/b`);
  assert.equal(redactText(p), p);
  assert.equal(containsPrivate({ p }), false);
});

test("rutas privadas de la web aunque parezcan técnicas", () => {
  assert.ok(redactText("https://miwebdeboda.com/dominio-propio/x").includes(REDACTED));
});

test("objetos anidados: claves personales fuera y texto redactado a cualquier profundidad", () => {
  const v = redactValue({
    page: "https://miwebdeboda.com/blog/a/b",
    nested: { deep: [{ note: `ver /${CANARIO}` }], bride: "CANARIO-PAREJA-7f3a", email: "x@y.z" },
    queries: ["web de boda"],
  }) as Record<string, unknown>;
  const s = JSON.stringify(v);
  assert.ok(!s.includes(CANARIO) && !s.includes("CANARIO-PAREJA") && !s.includes("x@y.z"), s);
  assert.ok(s.includes("https://miwebdeboda.com/blog/a/b") && s.includes("web de boda"));
  assert.equal(containsPrivate({ a: `/${CANARIO}` }), true);
  assert.equal(containsPrivate({ a: "/blog/x/y", n: 3 }), false);
});

test("contrato: el objetivo, la evidencia y el prompt nunca llevan nada privado", () => {
  const c = buildContract(
    {
      id: "o",
      stableKey: "e".repeat(64),
      findingType: "low-ctr",
      title: `CTR bajo; antes enlazaba a https://miwebdeboda.com/${CANARIO}`,
      detail: { page: "https://miwebdeboda.com/blog/a/b", from: { list: [`/${CANARIO}/i/abc`] }, groom: "CANARIO-NOVIO-7f3a" },
      page: "https://miwebdeboda.com/blog/a/b",
      operation: "meta-title-description",
      autonomy: "A1",
      lane: "technical",
      severity: "medium",
    },
    { now: new Date("2026-11-19T00:00:00Z"), changeId: "x" },
  );
  const out = JSON.stringify({ c, p: renderPrompt(c), t: taskTitle(c) });
  assert.ok(!out.includes(CANARIO) && !out.includes("CANARIO-NOVIO"), out);
  assert.equal(containsPrivate({ c, p: renderPrompt(c), t: taskTitle(c) }), false);
});
