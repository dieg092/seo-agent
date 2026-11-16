// src/bridge/guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW, BLOCK, HOLD, guardDecision, taskId8, type GuardInput, type GuardLink } from "./guard";

const TASK = "1a2b3c4d-0000-4000-8000-000000000000";
const link: GuardLink = {
  orbitaTaskId: TASK,
  operation: "meta-title-description",
  lane: "technical",
  autonomy: "A1",
  contract: { publishPolicy: "auto-merge-if-green" },
  closedAt: null,
};
const on = { masterSwitch: "on", pausedLanes: [], brakeState: "off" };
const pr = {
  title: "seo(1a2b3c4d): título de /precios",
  labels: ["seo-auto", "seo-op:meta-title-description"],
  state: "OPEN",
  baseRefName: "main",
  files: [{ path: "src/app/precios/page.tsx", added: 2, deleted: 2 }],
};
const run = (p: Partial<GuardInput>) => guardDecision({ stage: "preflight", control: on, link, ...p }).code;

test("taskId8 quita guiones y toma 8", () => {
  assert.equal(taskId8(TASK), "1a2b3c4d");
});

test("preflight: adelante solo con A1 de fusión automática y todo encendido", () => {
  assert.equal(run({}), ALLOW);
  assert.equal(run({ link: null }), BLOCK);
  assert.equal(run({ link: { ...link, closedAt: new Date() } }), BLOCK);
  assert.equal(run({ link: { ...link, autonomy: "A2" } }), BLOCK);
  assert.equal(run({ link: { ...link, contract: { publishPolicy: "pr-only" } } }), BLOCK);
});

test("freno, interruptor, carril en pausa o sin BD: retener", () => {
  assert.equal(run({ control: null }), HOLD);
  assert.equal(run({ control: { ...on, masterSwitch: "off" } }), HOLD);
  assert.equal(run({ control: { ...on, brakeState: "tripped" } }), HOLD);
  assert.equal(run({ control: { ...on, pausedLanes: ["technical"] } }), HOLD);
  assert.equal(run({ stage: "premerge", control: { ...on, brakeState: "tripped" }, pr, selfIntact: true }), HOLD);
});

test("scope: el diff tiene que caber en la operación", () => {
  assert.equal(run({ stage: "scope", diff: pr.files }), ALLOW);
  assert.equal(run({ stage: "scope", diff: [] }), BLOCK);
  assert.equal(run({ stage: "scope", diff: [{ path: "package.json", added: 1, deleted: 0 }] }), BLOCK);
  // con el freno, la tarea que ya trabajó abre su PR igualmente: la para el premerge
  assert.equal(run({ stage: "scope", diff: pr.files, control: { ...on, brakeState: "tripped" } }), ALLOW);
});

test("premerge: PR abierto contra main, título, etiquetas y ficheros", () => {
  assert.equal(run({ stage: "premerge", pr, selfIntact: true }), ALLOW);
  assert.equal(run({ stage: "premerge", pr, selfIntact: false }), HOLD);
  assert.equal(run({ stage: "premerge", selfIntact: true }), HOLD);
  assert.equal(run({ stage: "premerge", pr: { ...pr, state: "MERGED" }, selfIntact: true }), BLOCK);
  assert.equal(run({ stage: "premerge", pr: { ...pr, baseRefName: "dev" }, selfIntact: true }), BLOCK);
  assert.equal(run({ stage: "premerge", pr: { ...pr, title: "seo(ffffffff): otra" }, selfIntact: true }), BLOCK);
  assert.equal(run({ stage: "premerge", pr: { ...pr, labels: ["seo-op:meta-title-description"] }, selfIntact: true }), BLOCK);
  assert.equal(run({ stage: "premerge", pr: { ...pr, labels: ["seo-auto", "seo-op:image-alt"] }, selfIntact: true }), BLOCK);
  assert.equal(run({ stage: "premerge", pr: { ...pr, labels: [...pr.labels, "seo-op:image-alt"] }, selfIntact: true }), BLOCK);
  assert.equal(run({ stage: "premerge", pr: { ...pr, files: [{ path: ".github/workflows/ci.yml", added: 1, deleted: 0 }] }, selfIntact: true }), BLOCK);
});
