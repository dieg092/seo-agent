// src/collectors/brand.ts
// Consultas de marca (sección 2.2 de la spec). Las métricas principales se calculan
// sin ellas. Las filas de SearchConsoleSnapshot no guardan la marca: se calcula al leer.
export const BRAND_REGEX = /mi\s*web\s*de\s*boda|miwebdeboda|mwdb/i;

export function isBrandQuery(q: string): boolean {
  return BRAND_REGEX.test(q);
}
