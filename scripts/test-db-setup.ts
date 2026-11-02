// Aplica las migraciones a la BD de tests (nunca a producción).
// Uso: pnpm test:db:setup  (el script ya exporta SEO_ENV=test)
import { spawnSync } from "child_process";
import { isTestEnv } from "../src/env";
import { assertSafeDatabase } from "../src/db";

if (!isTestEnv()) {
  console.error("test:db:setup solo se ejecuta con SEO_ENV=test.");
  process.exit(1);
}

assertSafeDatabase(process.env.DATABASE_URL);
assertSafeDatabase(process.env.DIRECT_URL);

function prisma(args: string[], input?: string): number {
  const result = spawnSync("prisma", args, {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input,
    env: process.env,
    shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

console.log(`Migrando la BD de tests: ${process.env.DATABASE_URL}`);

// En Neon el esquema y la extensión ya existen; en una BD local nueva hay que
// crearlos antes de las migraciones, que dan ambos por hechos.
// Además, si una ejecución anterior dejó una migración fallida en la BD de tests,
// se marca como revertida (lo mismo que `prisma migrate resolve --rolled-back`)
// para poder reintentarla. Solo llega aquí con SEO_ENV=test y una BD que no es Neon.
const bootstrap = `
CREATE SCHEMA IF NOT EXISTS seo_agent;
CREATE EXTENSION IF NOT EXISTS vector;
DO $$
DECLARE t regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY[to_regclass('seo_agent._prisma_migrations'), to_regclass('public._prisma_migrations')]
  LOOP
    IF t IS NOT NULL THEN
      EXECUTE format('UPDATE %s SET rolled_back_at = now() WHERE finished_at IS NULL AND rolled_back_at IS NULL', t);
    END IF;
  END LOOP;
END $$;
`;
const bootstrapStatus = prisma(["db", "execute", "--stdin", "--schema", "prisma/schema.prisma"], bootstrap);
if (bootstrapStatus !== 0) process.exit(bootstrapStatus);

process.exit(prisma(["migrate", "deploy"]));
