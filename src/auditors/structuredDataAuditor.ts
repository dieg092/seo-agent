import * as cheerio from "cheerio";

export interface StructuredDataEntry {
  url: string;
  schemaType: string;
  isValid: boolean;
  errors: string[];
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  Article: ["headline", "author", "datePublished"],
  PhotographyBusiness: ["name", "address"],
  BreadcrumbList: ["itemListElement"],
  Organization: ["name", "url"],
  WebSite: ["name", "url"],
  DefinedTermSet: ["name"],
  Dataset: ["name", "description"],
};

function validateFields(data: Record<string, unknown>, type: string): string[] {
  const required = REQUIRED_FIELDS[type];
  if (!required) return [];
  return required
    .filter((field) => data[field] === undefined || data[field] === null || data[field] === "")
    .map((field) => `Falta el campo requerido "${field}" para el tipo ${type}`);
}

export async function auditStructuredData(deps: {
  urls: string[];
  fetchHtml?: (url: string) => Promise<string>;
}): Promise<StructuredDataEntry[]> {
  const fetchHtml =
    deps.fetchHtml ??
    (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Fetch failed: ${response.status}`);
      }
      return response.text();
    });

  const results: StructuredDataEntry[] = [];

  for (const url of deps.urls) {
    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (error) {
      results.push({ url, schemaType: "none", isValid: false, errors: [`No se pudo obtener la página: ${(error as Error).message}`] });
      continue;
    }

    const $ = cheerio.load(html);
    const scripts = $('script[type="application/ld+json"]');

    if (scripts.length === 0) {
      results.push({ url, schemaType: "none", isValid: false, errors: ["No se encontró ningún bloque JSON-LD en la página"] });
      continue;
    }

    scripts.each((_, el) => {
      const raw = $(el).contents().text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        results.push({ url, schemaType: "invalid-json", isValid: false, errors: ["El bloque JSON-LD no es JSON válido"] });
        return;
      }

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const entry = item as Record<string, unknown>;
          const schemaType = String(entry["@type"] ?? "unknown");
          const errors = validateFields(entry, schemaType);
          results.push({ url, schemaType, isValid: errors.length === 0, errors });
        }
        return;
      }

      const entry = parsed as Record<string, unknown>;
      const schemaType = String(entry["@type"] ?? "unknown");
      const errors = validateFields(entry, schemaType);
      results.push({ url, schemaType, isValid: errors.length === 0, errors });
    });
  }

  return results;
}
