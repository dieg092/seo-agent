import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptUrl, encryptUrl, hmac12, redactUrl } from "./redact";

// Claves ficticias, solo para tests.
const KEY = "clave-de-prueba-1";
const OTHER_KEY = "clave-de-prueba-2";

test("redactUrl de una privada no contiene el slug", () => {
  const redacted = redactUrl("https://miwebdeboda.com/ana-y-luis/i/abc", KEY);
  assert.match(redacted, /^https:\/\/miwebdeboda\.com\/<privada:[0-9a-f]{12}>$/);
  assert.ok(!redacted.includes("ana-y-luis"));
  assert.ok(!redacted.includes("abc>"));
});

test("redactUrl es estable entre http y https y con o sin barra final", () => {
  const a = redactUrl("https://miwebdeboda.com/ana-y-luis", KEY);
  assert.equal(redactUrl("http://miwebdeboda.com/ana-y-luis/", KEY), a);
  assert.equal(redactUrl("https://MiWebDeBoda.com/ana-y-luis", KEY), a);
  assert.equal(hmac12("http://miwebdeboda.com/ana-y-luis/", KEY), hmac12("https://miwebdeboda.com/ana-y-luis", KEY));
});

test("redactUrl cambia con otra clave", () => {
  assert.notEqual(
    redactUrl("https://miwebdeboda.com/ana-y-luis", KEY),
    redactUrl("https://miwebdeboda.com/ana-y-luis", OTHER_KEY)
  );
});

test("redactUrl devuelve las publicas normalizadas", () => {
  assert.equal(redactUrl("http://miwebdeboda.com/blog/x/", KEY), "https://miwebdeboda.com/blog/x");
});

test("redactUrl redacta los dominios propios", () => {
  const redacted = redactUrl("https://boda-de-prueba.example/", KEY);
  assert.ok(!redacted.includes("boda-de-prueba"));
  assert.match(redacted, /<privada:[0-9a-f]{12}>$/);
});

test("encryptUrl y decryptUrl: ida y vuelta", () => {
  const url = "https://miwebdeboda.com/ana-y-luis/i/abc";
  const blob = encryptUrl(url, KEY);
  assert.ok(!blob.includes("ana-y-luis"));
  assert.equal(decryptUrl(blob, KEY), url);
  assert.notEqual(encryptUrl(url, KEY), blob, "cada cifrado usa un iv distinto");
  assert.throws(() => decryptUrl(blob, OTHER_KEY));
});

test("sin clave lanza un error con SEO_PRIVATE_URL_KEY", () => {
  const saved = process.env.SEO_PRIVATE_URL_KEY;
  delete process.env.SEO_PRIVATE_URL_KEY;
  try {
    const url = "https://miwebdeboda.com/ana-y-luis";
    assert.throws(() => redactUrl(url), /SEO_PRIVATE_URL_KEY/);
    assert.throws(() => redactUrl("https://miwebdeboda.com/blog/x"), /SEO_PRIVATE_URL_KEY/);
    assert.throws(() => hmac12(url), /SEO_PRIVATE_URL_KEY/);
    assert.throws(() => encryptUrl(url), /SEO_PRIVATE_URL_KEY/);
    assert.throws(() => decryptUrl("AAAA", ""), /SEO_PRIVATE_URL_KEY/);
  } finally {
    if (saved !== undefined) process.env.SEO_PRIVATE_URL_KEY = saved;
  }
});

test("usa SEO_PRIVATE_URL_KEY del entorno si no se pasa clave", () => {
  const saved = process.env.SEO_PRIVATE_URL_KEY;
  process.env.SEO_PRIVATE_URL_KEY = KEY;
  try {
    const url = "https://miwebdeboda.com/ana-y-luis";
    assert.equal(redactUrl(url), redactUrl(url, KEY));
  } finally {
    if (saved === undefined) delete process.env.SEO_PRIVATE_URL_KEY;
    else process.env.SEO_PRIVATE_URL_KEY = saved;
  }
});
