// src/embeddings/cloudflareEmbeddings.ts
import { getEnv } from "../env";

const EMBEDDING_MODEL = "@cf/baai/bge-m3";

interface CloudflareAccount {
  token?: string;
  accountId?: string;
  label: string;
}

function getConfiguredAccounts(): CloudflareAccount[] {
  function tryGet(name: string): string | undefined {
    try {
      return getEnv(name);
    } catch {
      return undefined;
    }
  }

  return [
    { token: tryGet("CLOUDFLARE_WORKER_AI_API_TOKEN_2"), accountId: tryGet("CLOUDFLARE_ACCOUNT_ID_2"), label: "cuenta 2 (free)" },
    { token: tryGet("CLOUDFLARE_WORKER_AI_API_TOKEN_3"), accountId: tryGet("CLOUDFLARE_ACCOUNT_ID_3"), label: "cuenta 3 (free)" },
    { token: tryGet("CLOUDFLARE_WORKER_AI_API_TOKEN_4"), accountId: tryGet("CLOUDFLARE_ACCOUNT_ID_4"), label: "cuenta 4 (free)" },
    { token: tryGet("CLOUDFLARE_WORKER_AI_API_TOKEN"), accountId: tryGet("CLOUDFLARE_ACCOUNT_ID"), label: "cuenta 1 (pagada, fallback)" },
  ].filter((account): account is { token: string; accountId: string; label: string } => Boolean(account.token && account.accountId));
}

interface EmbeddingResponse {
  result?: { data?: number[][] };
}

export async function embedText(
  text: string,
  options: { fetchImpl?: typeof fetch; accounts?: CloudflareAccount[] } = {}
): Promise<number[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const accounts = options.accounts ?? getConfiguredAccounts();

  if (accounts.length === 0) {
    throw new Error("No hay ninguna cuenta de Cloudflare Workers AI configurada en el entorno");
  }

  let lastError: unknown;

  for (const account of accounts) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/run/${EMBEDDING_MODEL}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        lastError = new Error(`Cloudflare Workers AI (${account.label}) respondió ${response.status}`);
        continue;
      }

      const json = (await response.json()) as EmbeddingResponse;
      const vector = json.result?.data?.[0];

      if (!vector || vector.length === 0) {
        throw new Error("Cloudflare Workers AI no devolvió ningún vector de embedding");
      }

      return vector;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No se pudo generar el embedding con ninguna cuenta");
}
