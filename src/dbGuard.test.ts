// src/dbGuard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { testDatabaseProblem, describeDatabase } from "./db";

test("BD de tests: solo local y con nombre _test", () => {
  assert.equal(testDatabaseProblem("postgresql://localhost/seo_agent_test?host=/tmp"), null);
  assert.equal(testDatabaseProblem("postgresql://diego@127.0.0.1:5432/seo_agent_test"), null);
  assert.equal(testDatabaseProblem(undefined), null);
  assert.match(testDatabaseProblem("postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb")!, /no es local/);
  assert.match(testDatabaseProblem("postgresql://u:p@db.example.com/seo_agent_test")!, /no es local/);
  assert.match(testDatabaseProblem("postgresql://localhost/seo_agent?host=/tmp")!, /_test/);
  assert.match(testDatabaseProblem("mysql://localhost/x_test")!, /no es Postgres/);
  assert.match(testDatabaseProblem("no es una url")!, /no se puede leer/);
});

test("describeDatabase no enseña usuario, contraseña ni parámetros", () => {
  const d = describeDatabase("postgresql://usuario:secreto@ep-x.neon.tech/neondb?sslmode=require");
  assert.equal(d, "ep-x.neon.tech/neondb");
  assert.ok(!d.includes("secreto") && !d.includes("usuario"));
});
