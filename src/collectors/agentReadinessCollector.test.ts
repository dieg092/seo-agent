import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_CHECKS, fetchScan, parseScan, regressions, score, SCAN_TARGET } from "./agentReadinessCollector";

// Forma real de la respuesta de isitagentready.com (22-nov-2026), recortada.
const RESPONSE = {
  url: "https://miwebdeboda.com",
  level: 1,
  levelName: "Basic Web Presence",
  checks: {
    discoverability: {
      robotsTxt: { status: "pass", message: "ok", evidence: [{ body: "User-Agent: *" }] },
      sitemap: { status: "pass", message: "ok" },
      linkHeaders: { status: "fail", message: "No Link headers" },
      dnsAid: { status: "fail", message: "no" },
    },
    contentAccessibility: { markdownNegotiation: { status: "fail" } },
    botAccessControl: {
      robotsTxtAiRules: { status: "pass" },
      contentSignals: { status: "fail" },
      webBotAuth: { status: "neutral" },
    },
    commerce: { x402: { status: "neutral" } },
  },
  nextLevel: { target: 2, name: "Bot-Aware", requirements: [{ check: "contentSignals", prompt: "…" }] },
};

test("parseScan se queda con los estados, sin evidencia, y cuenta como la web", () => {
  const s = parseScan(RESPONSE);
  assert.equal(s.level, 1);
  assert.equal(s.checks.robotsTxt, "pass");
  assert.equal(s.checks.webBotAuth, "neutral");
  assert.ok(!JSON.stringify(s).includes("User-Agent"), "no debe guardar la evidencia cruda");
  // 3 aprobadas de 7 comprobadas (las neutrales no cuentan) = 43, como el perfil Content Site
  assert.equal(s.passed, 3);
  assert.equal(s.total, 7);
  assert.equal(score(s), 43);
  assert.deepEqual(s.nextLevel, { target: 2, name: "Bot-Aware", checks: ["contentSignals"] });
});

test("parseScan rechaza respuestas con formato desconocido", () => {
  assert.throws(() => parseScan({ error: "rate limited" }), /formato desconocido/);
  assert.throws(() => parseScan({ level: 1, levelName: "x", checks: { a: { b: { status: "raro" } } } }), /ninguna comprobación/);
});

test("regressions solo avisa si pasaba y falla en los dos últimos escaneos", () => {
  const pass = { checks: { contentSignals: "pass" as const } };
  const fail = { checks: { contentSignals: "fail" as const } };
  assert.deepEqual(regressions([fail, fail, pass]), ["contentSignals"]);
  assert.deepEqual(regressions([fail, pass, pass]), [], "un fallo suelto no avisa");
  assert.deepEqual(regressions([fail, fail, fail]), [], "lo que nunca pasó no es regresión");
  assert.deepEqual(regressions([fail, fail]), [], "sin historial suficiente no avisa");
});

test("fetchScan escanea solo la home, pide el perfil de contenido y reintenta", async () => {
  const calls: { url: string; body: { url: string; enabledChecks?: string[] } }[] = [];
  let n = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    n++;
    if (n === 1) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => RESPONSE };
  };
  const s = await fetchScan("content", fetcher, 2);
  assert.equal(s.passed, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.url, SCAN_TARGET);
  assert.deepEqual(calls[0].body.enabledChecks, [...CONTENT_CHECKS]);

  const all: { enabledChecks?: string[] }[] = [];
  await fetchScan("all", async (_u, init) => {
    all.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => RESPONSE };
  });
  assert.equal(all[0].enabledChecks, undefined, "el perfil all no limita comprobaciones");
});

test("fetchScan falla tras agotar los intentos", async () => {
  await assert.rejects(
    fetchScan("content", async () => ({ ok: false, status: 429, json: async () => ({}) }), 1),
    /429/,
  );
});
