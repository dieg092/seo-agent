import { isTestEnv } from "./env";
import { PrismaClient } from "@prisma/client";

/**
 * Guarda contra tocar producción desde los tests: con SEO_ENV=test, una URL
 * de base de datos que apunte a Neon (producción) es un error.
 */
export function assertSafeDatabase(url: string | undefined): void {
  if (isTestEnv() && url && url.toLowerCase().includes("neon.tech")) {
    throw new Error(
      "SEO_ENV=test con una BD de Neon (neon.tech): los tests no pueden usar producción. " +
        "Usa la BD local (postgresql://localhost/seo_agent_test?host=/tmp) o un .env.test propio."
    );
  }
}

assertSafeDatabase(process.env.DATABASE_URL);
assertSafeDatabase(process.env.DIRECT_URL);

// La URL se pasa explícita para que Prisma no la busque por su cuenta en .env.
export const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
