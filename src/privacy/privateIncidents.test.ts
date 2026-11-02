// src/privacy/privateIncidents.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../db";
import { decryptUrl, hmac12 } from "./redact";
import { recordPrivateExposure } from "./privateIncidents";

// Clave y URLs ficticias, solo para tests. Los tests solo borran estos incidentes.
const KEY = "clave-ficticia-de-test-incidentes";
process.env.SEO_PRIVATE_URL_KEY = KEY;
const URL_A = "https://miwebdeboda.com/test-incidente-ficticio/i/token-ficticio";
const URL_B = "https://miwebdeboda.com/test-incidente-cifrado";

async function cleanup() {
  await prisma.privateIncident.deleteMany({ where: { urlHmac: { in: [hmac12(URL_A, KEY), hmac12(URL_B, KEY)] } } });
}

type AlertArgs = { type: string; subject: string; body: string };

test("recordPrivateExposure alerta una sola vez", async () => {
  await cleanup();
  try {
    const alerts: AlertArgs[] = [];
    const alert = async (a: AlertArgs) => {
      alerts.push(a);
    };

    const first = await recordPrivateExposure(URL_A, "gsc:web", { alert, now: new Date("2001-05-01T00:00:00Z") });
    const second = await recordPrivateExposure(URL_A, "probe:sitemap", { alert, now: new Date("2001-05-02T00:00:00Z") });
    // La misma URL con http y barra final es el mismo incidente.
    const third = await recordPrivateExposure(URL_A.replace("https:", "http:") + "/", "gsc:web", {
      alert,
      now: new Date("2001-05-03T00:00:00Z"),
    });

    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(third.isNew, false);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "private-page-exposed");
    assert.ok(!alerts[0].body.includes("test-incidente"), "la alerta no lleva la URL real");
    assert.ok(alerts[0].body.includes(hmac12(URL_A, KEY)));

    const incident = await prisma.privateIncident.findUnique({ where: { urlHmac: hmac12(URL_A, KEY) } });
    assert.ok(incident);
    assert.deepEqual(incident.sources, ["gsc:web", "probe:sitemap"]);
    assert.equal(incident.firstSeenAt.toISOString(), "2001-05-01T00:00:00.000Z");
    assert.equal(incident.lastSeenAt.toISOString(), "2001-05-03T00:00:00.000Z");

    // Si estaba resuelto y vuelve a aparecer, se reabre y se avisa otra vez.
    await prisma.privateIncident.update({ where: { urlHmac: hmac12(URL_A, KEY) }, data: { resolvedAt: new Date() } });
    const reopened = await recordPrivateExposure(URL_A, "gsc:web", { alert });
    assert.equal(reopened.isNew, true);
    assert.equal(alerts.length, 2);
    const after = await prisma.privateIncident.findUnique({ where: { urlHmac: hmac12(URL_A, KEY) } });
    assert.equal(after?.resolvedAt, null);
  } finally {
    await cleanup();
  }
});

test("guarda la url cifrada y descifrable", async () => {
  await cleanup();
  try {
    await recordPrivateExposure(URL_B, "probe:private-sample", { alert: async () => {} });
    const incident = await prisma.privateIncident.findUnique({ where: { urlHmac: hmac12(URL_B, KEY) } });
    assert.ok(incident);
    assert.ok(!incident.urlEncrypted.includes("test-incidente"), "la URL no se guarda en claro");
    assert.equal(decryptUrl(incident.urlEncrypted, KEY), URL_B);
  } finally {
    await cleanup();
  }
});

test("sin SEO_PRIVATE_URL_KEY falla sin escribir ni alertar", async () => {
  const saved = process.env.SEO_PRIVATE_URL_KEY;
  delete process.env.SEO_PRIVATE_URL_KEY;
  let alerted = false;
  try {
    await assert.rejects(
      () => recordPrivateExposure(URL_B, "gsc:web", { alert: async () => void (alerted = true) }),
      /SEO_PRIVATE_URL_KEY/
    );
    assert.equal(alerted, false);
  } finally {
    process.env.SEO_PRIVATE_URL_KEY = saved;
  }
});
