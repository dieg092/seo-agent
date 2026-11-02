// scripts/daily-collection-workflow.test.ts
// Comprueba que el workflow diario tiene conectados los pasos de la fase 1 (Task 9):
// que existen, que llevan continue-on-error, que report-workflow-health los cuenta y
// que reciben SEO_PRIVATE_URL_KEY (secret) y PRIVATE_PROBE_URLS (variable).
// Se lee el YAML como texto para no añadir una dependencia solo para esto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const WORKFLOW = readFileSync(join(__dirname, "..", ".github", "workflows", "daily-collection.yml"), "utf8");

type Step = { id: string | null; body: string };

/** Trocea la lista `steps:` del job en pasos (cada uno empieza por `      - `). */
function parseSteps(yaml: string): Step[] {
  const stepsStart = yaml.indexOf("\n    steps:\n");
  assert.ok(stepsStart >= 0, "el job no tiene steps");
  const lines = yaml.slice(stepsStart).split("\n").slice(2);
  const steps: Step[] = [];
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    const body = current.join("\n");
    const id = /(?:^|\n)\s*-?\s*id:\s*([\w-]+)/.exec(body)?.[1] ?? null;
    steps.push({ id, body });
  };
  for (const line of lines) {
    if (/^      - /.test(line)) {
      flush();
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  flush();
  return steps;
}

const STEPS = parseSteps(WORKFLOW);

// Pasos nuevos de la fase 1 y el script de package.json que ejecutan.
const NEW_STEPS: Record<string, string> = {
  "collect-gsc-full": "collect:search-console-full",
  "collect-url-inspection": "collect:url-inspection",
  "audit-production": "audit:production",
};

// Pasos de recogida/auditoría que no deben tumbar el resto del workflow.
const NON_BLOCKING_STEPS = [
  "collect-gsc",
  "collect-gsc-full",
  "collect-ga4",
  "collect-url-inspection",
  "audit-sitemap",
  "audit-robots",
  "audit-structured-data",
  "audit-performance",
  "audit-production",
];

function step(id: string): Step {
  const found = STEPS.find((s) => s.id === id);
  assert.ok(found, `falta el paso ${id}`);
  return found;
}

function reportedOutcomes(): string[] {
  const report = STEPS.find((s) => s.body.includes("scripts/report-workflow-health.ts"));
  assert.ok(report, "falta el paso report-workflow-health");
  assert.match(report.body, /if: always\(\)/);
  return [...report.body.matchAll(/steps\.([\w-]+)\.outcome/g)].map((m) => m[1]);
}

test("los pasos nuevos existen y ejecutan un script que está en package.json", () => {
  const scripts = packageJson.scripts;
  for (const [id, script] of Object.entries(NEW_STEPS)) {
    assert.match(step(id).body, new RegExp(`run: pnpm ${script.replace(/[:-]/g, "\\$&")}\\s*(\\n|$)`));
    assert.ok(scripts[script], `package.json no tiene el script ${script}`);
  }
});

test("los pasos de recogida y auditoría llevan continue-on-error", () => {
  for (const id of NON_BLOCKING_STEPS) {
    assert.match(step(id).body, /continue-on-error: true/, `${id} sin continue-on-error`);
  }
});

test("report-workflow-health incluye el resultado de todos los pasos con id", () => {
  const reported = reportedOutcomes();
  const ids = STEPS.map((s) => s.id).filter((id): id is string => id !== null && id !== "telegram-message");
  for (const id of ids) assert.ok(reported.includes(id), `report-workflow-health no cuenta ${id}`);
  assert.equal(new Set(reported).size, reported.length, "hay pasos repetidos en report-workflow-health");
  for (const id of reported) assert.ok(ids.includes(id), `report-workflow-health cuenta un paso que no existe: ${id}`);
});

test("los pasos nuevos van antes de priorizar y la sonda después de la inspección", () => {
  const order = STEPS.map((s) => s.id);
  const prioritize = order.indexOf("prioritize");
  assert.ok(prioritize >= 0);
  for (const id of Object.keys(NEW_STEPS)) assert.ok(order.indexOf(id) < prioritize, `${id} va después de prioritize`);
  // La sonda lee los incidentes privados que dejan GSC completo e inspección de URLs.
  assert.ok(order.indexOf("collect-gsc-full") < order.indexOf("audit-production"));
  assert.ok(order.indexOf("collect-url-inspection") < order.indexOf("audit-production"));
});

test("SEO_PRIVATE_URL_KEY llega como secret y PRIVATE_PROBE_URLS como variable", () => {
  assert.match(WORKFLOW, /\n      SEO_PRIVATE_URL_KEY: \$\{\{ secrets\.SEO_PRIVATE_URL_KEY \}\}\n/);
  assert.match(WORKFLOW, /\n      PRIVATE_PROBE_URLS: \$\{\{ vars\.PRIVATE_PROBE_URLS \}\}\n/);
  // La clave nunca como variable (las variables se ven en claro en los logs).
  assert.doesNotMatch(WORKFLOW, /vars\.SEO_PRIVATE_URL_KEY/);
});

test(".env.example documenta las variables nuevas sin valor", () => {
  const example = readFileSync(join(__dirname, "..", ".env.example"), "utf8");
  assert.match(example, /^SEO_PRIVATE_URL_KEY=$/m);
  assert.match(example, /^PRIVATE_PROBE_URLS=$/m);
});
