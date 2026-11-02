import { config } from "dotenv";
import { existsSync } from "fs";
import { userInfo } from "os";
import { join } from "path";

// BD local de tests (Postgres 17 con pgvector) que se usa si no hay .env.test.
export const DEFAULT_TEST_DATABASE_URL = "postgresql://localhost/seo_agent_test?host=/tmp";

/**
 * Prisma, sin usuario en la URL, se conecta como el rol `postgres` (que en un
 * Postgres de Homebrew no existe). psql usaría el usuario del sistema: hacemos
 * lo mismo para que la URL por defecto funcione igual con los dos.
 */
export function withLocalUser(url: string, username: string = userInfo().username): string {
  const parsed = new URL(url);
  if (!parsed.username && username) parsed.username = encodeURIComponent(username);
  return parsed.toString();
}

export function isTestEnv(): boolean {
  return process.env.SEO_ENV === "test";
}

/**
 * Carga las variables de entorno.
 * - Modo normal: lee `.env` (sin pisar lo que ya venga del entorno).
 * - Modo test (`SEO_ENV=test`): nunca lee `.env`. Carga `.env.test` con override
 *   si existe; si no, DATABASE_URL y DIRECT_URL apuntan a la BD local de tests,
 *   aunque el entorno traiga otras (por ejemplo, las de producción).
 */
export function loadEnv(rootDir: string = join(__dirname, "..")): void {
  if (!isTestEnv()) {
    config({ path: join(rootDir, ".env"), quiet: true });
    return;
  }

  const testEnvPath = join(rootDir, ".env.test");
  const parsed = existsSync(testEnvPath)
    ? config({ path: testEnvPath, override: true, quiet: true }).parsed ?? {}
    : {};

  // Lo que no defina .env.test no se hereda del entorno: se usa la BD local.
  process.env.DATABASE_URL = parsed.DATABASE_URL || withLocalUser(DEFAULT_TEST_DATABASE_URL);
  process.env.DIRECT_URL = parsed.DIRECT_URL || process.env.DATABASE_URL;

  // Configuración no secreta que antes llegaba del .env real. Los tests no
  // llaman a ningún servicio: los clientes externos se inyectan como dependencias.
  for (const [key, value] of Object.entries(TEST_CONFIG_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

const TEST_CONFIG_DEFAULTS: Record<string, string> = {
  SITE_BASE_URL: "https://miwebdeboda.com",
  GSC_SITE_URL: "sc-domain:miwebdeboda.com",
  GA4_PROPERTY_ID: "000000000",
  GITHUB_REPO_OWNER: "propietario-de-prueba",
  GITHUB_REPO_NAME: "repo-de-prueba",
  WEDDING_INVITE_2_PAT: "token-de-prueba",
};

loadEnv();

export function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
