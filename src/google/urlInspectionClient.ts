// src/google/urlInspectionClient.ts
// Cliente de URL Inspection (§10.2 de la spec). Devuelve el estado de la versión
// indexada por Google, no una prueba en directo. Cuota: 2.000 al día y 600 por minuto
// por sitio; el presupuesto lo controla el colector.
import { google, type searchconsole_v1 } from "googleapis";
import { getEnv } from "../env";

export interface InspectionResult {
  verdict?: string;
  coverageState?: string;
  indexingState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  userCanonical?: string;
  crawledAs?: string;
  richResultsVerdict?: string;
  richResultsItems?: unknown;
}

let client: searchconsole_v1.Searchconsole | null = null;

function getClient(): searchconsole_v1.Searchconsole {
  if (client) return client;
  const auth = new google.auth.JWT(
    getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    undefined,
    getEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/webmasters.readonly"]
  );
  client = google.searchconsole({ version: "v1", auth });
  return client;
}

// La API devuelve null en los campos ausentes; aquí se dejan como undefined.
function opt(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

/** Convierte la respuesta de la API al formato que guarda el colector. */
export function mapInspectionResult(result: searchconsole_v1.Schema$UrlInspectionResult | undefined): InspectionResult {
  const index = result?.indexStatusResult;
  const rich = result?.richResultsResult;
  return {
    verdict: opt(index?.verdict),
    coverageState: opt(index?.coverageState),
    indexingState: opt(index?.indexingState),
    robotsTxtState: opt(index?.robotsTxtState),
    pageFetchState: opt(index?.pageFetchState),
    lastCrawlTime: opt(index?.lastCrawlTime),
    googleCanonical: opt(index?.googleCanonical),
    userCanonical: opt(index?.userCanonical),
    crawledAs: opt(index?.crawledAs),
    richResultsVerdict: opt(rich?.verdict),
    richResultsItems: rich?.detectedItems ?? undefined,
  };
}

export async function inspectUrl(url: string): Promise<InspectionResult> {
  const response = await getClient().urlInspection.index.inspect({
    requestBody: { inspectionUrl: url, siteUrl: getEnv("GSC_SITE_URL"), languageCode: "es-ES" },
  });
  return mapInspectionResult(response.data.inspectionResult);
}
