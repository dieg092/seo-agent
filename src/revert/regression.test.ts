// src/revert/regression.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { findChangeCommit, parseHead, regressionKey, regressionReasons } from "./regression";

const CANARY = "https://miwebdeboda.com/seo-canario";
const PRICES = "https://miwebdeboda.com/precios";

test("regresiones: estado, title vacío e indexación", () => {
  assert.deepEqual(regressionReasons(PRICES, { status: 200, title: "Precios", robots: "index, follow" }), []);
  assert.deepEqual(regressionReasons(CANARY, { status: 200, title: "Canario", robots: "noindex, nofollow" }), []);
  assert.deepEqual(regressionReasons(CANARY, { status: 200, title: "", robots: "noindex, nofollow" }), ["title vacío"]);
  assert.deepEqual(regressionReasons(PRICES, { status: 200, title: "Precios", robots: "noindex" }), ["noindex nuevo"]);
  assert.deepEqual(regressionReasons(CANARY, { status: 200, title: "C", robots: null }), ["ha perdido el noindex"]);
  assert.deepEqual(regressionReasons(PRICES, { status: 500, title: null, robots: null }), ["responde 500", "title vacío"]);
});

test("parseHead lee title y robots", () => {
  assert.deepEqual(parseHead('<head><title>Canario &amp; co</title><meta name="robots" content="noindex, nofollow"/></head>'), { title: "Canario & co", robots: "noindex, nofollow" });
  assert.deepEqual(parseHead("<head><title></title></head>"), { title: "", robots: null });
  assert.deepEqual(parseHead("<head></head>"), { title: null, robots: null });
});

test("commit del cambio y si ya está revertido", () => {
  const log = [
    { sha: "c3", subject: 'Revert "seo(1a2b3c4d): título"' },
    { sha: "c2", subject: "seo(1a2b3c4d): título" },
    { sha: "c1", subject: "otra cosa" },
  ];
  assert.deepEqual(findChangeCommit(log, "1a2b3c4d"), { sha: "c2", reverted: true });
  assert.deepEqual(findChangeCommit(log.slice(1), "1A2B3C4D"), { sha: "c2", reverted: false });
  assert.deepEqual(findChangeCommit(log.slice(2), "1a2b3c4d"), { sha: null, reverted: false });
  assert.equal(regressionKey("1a2b3c4d").length, 64);
});
