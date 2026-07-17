import { getEnv } from "../env";

export async function auditRobots(deps: {
  fetchText?: (url: string) => Promise<string>;
  baseUrl?: string;
} = {}): Promise<{ isValid: boolean; errors: string[] }> {
  const baseUrl = deps.baseUrl ?? getEnv("SITE_BASE_URL");
  const fetchText =
    deps.fetchText ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`robots.txt fetch failed: ${response.status}`);
      }
      return response.text();
    });

  const errors: string[] = [];
  let text: string;
  try {
    text = await fetchText(`${baseUrl}/robots.txt`);
  } catch (error) {
    return { isValid: false, errors: [`No se pudo obtener robots.txt: ${(error as Error).message}`] };
  }

  const lines = text.split("\n").map((l) => l.trim());

  if (!lines.some((l) => /^sitemap:/i.test(l))) {
    errors.push("robots.txt no declara ninguna directiva Sitemap:");
  }

  const hasBlanketDisallow = lines.some((l) => /^disallow:\s*\/\s*$/i.test(l));
  if (hasBlanketDisallow) {
    errors.push("robots.txt contiene 'Disallow: /' — bloquearía la indexación de todo el sitio");
  }

  return { isValid: errors.length === 0, errors };
}
