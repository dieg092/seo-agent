import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBrake, gateDecision, isExactInverse, mayCreate, seoChangeIds, type BrakeInputs } from "./brake";

const calm: BrakeInputs = {
  indexedNow: 160,
  indexed7dAgo: 164,
  openPrivateIncidents: 0,
  recentTaskOutcomes: ["done", "blocked", "done"],
  tasksCreated24h: 4,
  impressions7d: 900,
  impressionsPrior7d: 1000,
  criticalCollectorFailDays: 0,
};

test("sin disparadores no salta", () => {
  assert.deepEqual(evaluateBrake(calm), { trip: false, reasons: [], pauseLanes: [] });
});

test("cada disparador de §14 salta el freno", () => {
  const cases: Partial<BrakeInputs>[] = [
    { indexedNow: 140 },
    { openPrivateIncidents: 1 },
    { recentTaskOutcomes: ["blocked", "blocked", "failed", "done"] },
    { tasksCreated24h: 16 },
    { impressions7d: 600 },
  ];
  for (const c of cases) assert.equal(evaluateBrake({ ...calm, ...c }).trip, true, JSON.stringify(c));
});

test("umbrales: caídas pequeñas o con poca base no saltan", () => {
  assert.equal(evaluateBrake({ ...calm, indexedNow: 2, indexed7dAgo: 4 }).trip, false); // pierde 2 < 3 URLs
  assert.equal(evaluateBrake({ ...calm, impressions7d: 100, impressionsPrior7d: 400 }).trip, false); // base < 500
});

test("calidad de datos: 2 días sin GSC pausan content y links sin saltar el freno", () => {
  const d = evaluateBrake({ ...calm, criticalCollectorFailDays: 2 });
  assert.equal(d.trip, false);
  assert.deepEqual(d.pauseLanes, ["content", "links"]);
});

test("mayCreate respeta freno, interruptor y carriles en pausa", () => {
  const on = { masterSwitch: "on", pausedLanes: [], brakeState: "off" };
  assert.equal(mayCreate(on, "content", "meta-title-description"), true);
  const tripped = { ...on, brakeState: "tripped" };
  assert.equal(mayCreate(tripped, "content", "meta-title-description"), false);
  assert.equal(mayCreate(tripped, "content", "investigation"), true);
  assert.equal(mayCreate(tripped, "urgent", "jsonld-fix"), true);
  assert.equal(mayCreate({ ...on, masterSwitch: "off" }, "technical", "jsonld-fix"), false);
  assert.equal(mayCreate({ ...on, pausedLanes: ["links"] }, "links", "internal-links-batch"), false);
  assert.equal(mayCreate(null, "content", "investigation"), false);
  assert.equal(mayCreate(null, "urgent", "manual"), true);
});

test("seo-brake-gate: nunca bloquea un rango sin cambios SEO; cierra si no puede leer", () => {
  const subjects = ["arregla el footer", "seo(ab12cd34): title de /precios"];
  assert.deepEqual(seoChangeIds(subjects), ["ab12cd34"]);
  assert.deepEqual(gateDecision("push", ["arregla el footer"], null), { allow: true, seoChangeIds: [] });
  assert.equal(gateDecision("push", subjects, null).allow, false);
  assert.equal(gateDecision("push", subjects, { masterSwitch: "on", pausedLanes: [], brakeState: "tripped" }).allow, false);
  assert.equal(gateDecision("push", subjects, { masterSwitch: "on", pausedLanes: [], brakeState: "off" }).allow, true);
  assert.equal(gateDecision("pr", [], { masterSwitch: "off", pausedLanes: [], brakeState: "off" }).allow, false);
});

const COMMIT = `diff --git a/src/app/precios/page.tsx b/src/app/precios/page.tsx
index 111..222 100644
--- a/src/app/precios/page.tsx
+++ b/src/app/precios/page.tsx
@@ -1,3 +1,3 @@
-  title: "Precios viejos",
+  title: "Precios nuevos",
   description: "x",`;

const REVERT = `diff --git a/src/app/precios/page.tsx b/src/app/precios/page.tsx
index 222..111 100644
--- a/src/app/precios/page.tsx
+++ b/src/app/precios/page.tsx
@@ -1,3 +1,3 @@
-  title: "Precios nuevos",
+  title: "Precios viejos",
   description: "x",`;

test("revert-change: el diff tiene que ser el inverso exacto", () => {
  assert.equal(isExactInverse(COMMIT, REVERT), true);
  assert.equal(isExactInverse(COMMIT, REVERT.replace("Precios viejos", "Precios otros")), false);
  assert.equal(isExactInverse(COMMIT, COMMIT), false);
  assert.equal(isExactInverse("", ""), false);
});
