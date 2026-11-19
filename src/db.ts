import { isTestEnv } from "./env";
import { PrismaClient } from "@prisma/client";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

/**
 * Identidad positiva de la BD de tests: con SEO_ENV=test solo vale una BD local
 * (localhost o socket) cuyo nombre acabe en `_test`. Cualquier otra cosa (Neon,
 * otro host, otro nombre, una URL ilegible) es un error antes de conectar.
 */
export function testDatabaseProblem(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "la URL de la BD no se puede leer";
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return "la BD no es Postgres";
  const host = u.hostname.toLowerCase();
  if (host.endsWith("neon.tech")) return "la BD es de Neon (neon.tech), no es local";
  if (!LOCAL_HOSTS.has(host)) return "la BD no es local";
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!name.endsWith("_test")) return "el nombre de la BD no acaba en _test";
  return null;
}

/** Guarda contra tocar producción desde los tests. */
export function assertSafeDatabase(url: string | undefined): void {
  if (!isTestEnv()) return;
  const problem = testDatabaseProblem(url);
  if (problem) {
    throw new Error(
      `SEO_ENV=test con una BD que no es la de tests (${problem}): los tests no pueden usar producción. ` +
        "Usa la BD local (postgresql://localhost/seo_agent_test?host=/tmp) o un .env.test propio."
    );
  }
}

/** Host y nombre de la BD, sin usuario, contraseña ni parámetros (para logs). */
export function describeDatabase(url: string | undefined): string {
  if (!url) return "(sin BD)";
  try {
    const u = new URL(url);
    return `${u.hostname || "socket"}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(URL ilegible)";
  }
}

assertSafeDatabase(process.env.DATABASE_URL);
assertSafeDatabase(process.env.DIRECT_URL);

// La URL se pasa explícita para que Prisma no la busque por su cuenta en .env.
export const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
