import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getEnv, loadEnv, withLocalUser, DEFAULT_TEST_DATABASE_URL } from "./env";

const KEYS = ["SEO_ENV", "DATABASE_URL", "DIRECT_URL", "SEO_AGENT_TEST_FROM_FILE"] as const;

// Ejecuta fn en un directorio temporal y restaura las variables tocadas al terminar.
function withTempRoot(fn: (dir: string) => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const dir = mkdtempSync(join(tmpdir(), "seo-agent-env-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("loadEnv en modo test sin .env.test usa la BD local y no lee .env", () => {
  withTempRoot((dir) => {
    writeFileSync(join(dir, ".env"), 'DATABASE_URL="postgresql://x@prod.neon.tech/db"\nSEO_AGENT_TEST_FROM_FILE=env\n');
    process.env.SEO_ENV = "test";
    process.env.DATABASE_URL = "postgresql://x@shell.neon.tech/db";
    delete process.env.DIRECT_URL;
    delete process.env.SEO_AGENT_TEST_FROM_FILE;

    loadEnv(dir);

    assert.equal(process.env.DATABASE_URL, withLocalUser(DEFAULT_TEST_DATABASE_URL));
    assert.equal(process.env.DIRECT_URL, process.env.DATABASE_URL);
    assert.equal(process.env.SEO_AGENT_TEST_FROM_FILE, undefined);
  });
});

test("withLocalUser añade el usuario del sistema solo si la URL no trae uno", () => {
  assert.equal(
    withLocalUser(DEFAULT_TEST_DATABASE_URL, "ana"),
    "postgresql://ana@localhost/seo_agent_test?host=/tmp"
  );
  assert.equal(
    withLocalUser("postgresql://otro@localhost/seo_agent_test?host=/tmp", "ana"),
    "postgresql://otro@localhost/seo_agent_test?host=/tmp"
  );
});

test("loadEnv en modo test carga .env.test con override y nunca .env", () => {
  withTempRoot((dir) => {
    writeFileSync(join(dir, ".env"), "SEO_AGENT_TEST_FROM_FILE=env\n");
    writeFileSync(
      join(dir, ".env.test"),
      'DATABASE_URL="postgresql://localhost/otra_bd_test"\nSEO_AGENT_TEST_FROM_FILE=envtest\n'
    );
    process.env.SEO_ENV = "test";
    process.env.SEO_AGENT_TEST_FROM_FILE = "shell";
    process.env.DIRECT_URL = "postgresql://x@shell.neon.tech/db";

    loadEnv(dir);

    assert.equal(process.env.SEO_AGENT_TEST_FROM_FILE, "envtest");
    assert.equal(process.env.DATABASE_URL, "postgresql://localhost/otra_bd_test");
    // Sin DIRECT_URL en .env.test se usa la misma DATABASE_URL, no la del entorno.
    assert.equal(process.env.DIRECT_URL, "postgresql://localhost/otra_bd_test");
  });
});

test("loadEnv fuera del modo test lee .env sin pisar el entorno", () => {
  withTempRoot((dir) => {
    writeFileSync(join(dir, ".env"), "SEO_AGENT_TEST_FROM_FILE=env\nDATABASE_URL=postgresql://localhost/desde_env\n");
    delete process.env.SEO_ENV;
    delete process.env.SEO_AGENT_TEST_FROM_FILE;
    process.env.DATABASE_URL = "postgresql://localhost/desde_shell";

    loadEnv(dir);

    assert.equal(process.env.SEO_AGENT_TEST_FROM_FILE, "env");
    assert.equal(process.env.DATABASE_URL, "postgresql://localhost/desde_shell");
  });
});

test("getEnv returns the value when the variable is set", () => {
  process.env.SEO_AGENT_TEST_VAR = "hello";
  assert.equal(getEnv("SEO_AGENT_TEST_VAR"), "hello");
  delete process.env.SEO_AGENT_TEST_VAR;
});

test("getEnv throws when the variable is missing", () => {
  delete process.env.SEO_AGENT_TEST_VAR;
  assert.throws(
    () => getEnv("SEO_AGENT_TEST_VAR"),
    /SEO_AGENT_TEST_VAR/
  );
});

test("getEnv throws when the variable is an empty string", () => {
  process.env.SEO_AGENT_TEST_VAR = "";
  assert.throws(
    () => getEnv("SEO_AGENT_TEST_VAR"),
    /SEO_AGENT_TEST_VAR/
  );
  delete process.env.SEO_AGENT_TEST_VAR;
});
