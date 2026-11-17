// src/githubJobs/runGithubJobs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planJobs } from "./runGithubJobs";

const NOW = new Date("2026-11-18T09:00:00Z");
const h = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

test("tier1 solo después de la recogida de hoy y una vez por recogida", () => {
  assert.equal(planJobs(NOW, { collection: null }).tier1, false);
  assert.equal(planJobs(NOW, { collection: h(30) }).tier1, false, "recogida de ayer");
  assert.equal(planJobs(NOW, { collection: h(2) }).tier1, true);
  assert.equal(planJobs(NOW, { collection: h(2), tier1: h(1) }).tier1, false, "ya aplicado tras la recogida");
  assert.equal(planJobs(NOW, { collection: h(2), tier1: h(26) }).tier1, true);
});

test("sincronización semanal", () => {
  assert.equal(planJobs(NOW, {}).weekly, true);
  assert.equal(planJobs(NOW, { weekly: h(24) }).weekly, false);
  assert.equal(planJobs(NOW, { weekly: h(7 * 24) }).weekly, true);
});
