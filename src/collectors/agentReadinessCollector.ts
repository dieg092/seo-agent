// src/collectors/agentReadinessCollector.ts
// Nota de «agent readiness» de la home según isitagentready.com (escáner público de
// Cloudflare): robots.txt, sitemap, Content-Signal, cabeceras Link, Markdown para
// agentes, agent skills… Una fila por perfil y ejecución en AgentReadinessScan.
// Solo se escanea la home pública: nunca una URL que venga de otro sitio.
// Avisa cuando una comprobación que pasaba deja de pasar en dos escaneos seguidos
// (un escaneo suelto puede fallar por la red del escáner).
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";

export const SCAN_ENDPOINT = "https://isitagentready.com/api/scan";
export const SCAN_TARGET = "https://miwebdeboda.com/";

// Perfil «Content Site» del escáner: lo que aplica a una web de contenido. Es la
// métrica principal. «all» se guarda solo como tendencia.
export const CONTENT_CHECKS = [
  "robotsTxt",
  "sitemap",
  "linkHeaders",
  "dnsAid",
  "markdownNegotiation",
  "robotsTxtAiRules",
  "contentSignals",
] as const;

export type Profile = "content" | "all";
export type CheckStatus = "pass" | "fail" | "neutral";

export interface ParsedScan {
  level: number;
  levelName: string;
  checks: Record<string, CheckStatus>;
  passed: number;
  total: number;
  nextLevel: { target: number; name: string; checks: string[] } | null;
}

const STATUSES = new Set<CheckStatus>(["pass", "fail", "neutral"]);

/** Valida la respuesta del escáner y se queda solo con los estados (sin evidencia cruda). */
export function parseScan(json: unknown): ParsedScan {
  const j = json as {
    level?: unknown;
    levelName?: unknown;
    checks?: Record<string, Record<string, { status?: unknown }>>;
    nextLevel?: { target?: unknown; name?: unknown; requirements?: { check?: unknown }[] } | null;
  };
  if (typeof j?.level !== "number" || typeof j.levelName !== "string" || !j.checks || typeof j.checks !== "object") {
    throw new Error("respuesta del escáner con formato desconocido");
  }
  const checks: Record<string, CheckStatus> = {};
  for (const category of Object.values(j.checks)) {
    if (!category || typeof category !== "object") continue;
    for (const [key, value] of Object.entries(category)) {
      const status = value?.status;
      if (typeof status === "string" && STATUSES.has(status as CheckStatus)) checks[key] = status as CheckStatus;
    }
  }
  if (!Object.keys(checks).length) throw new Error("el escáner no devolvió ninguna comprobación");
  const counted = Object.values(checks).filter((s) => s !== "neutral");
  const next = j.nextLevel;
  return {
    level: j.level,
    levelName: j.levelName,
    checks,
    passed: counted.filter((s) => s === "pass").length,
    total: counted.length,
    nextLevel:
      next && typeof next.target === "number" && typeof next.name === "string"
        ? {
            target: next.target,
            name: next.name,
            checks: (next.requirements ?? []).map((r) => r.check).filter((c): c is string => typeof c === "string"),
          }
        : null,
  };
}

/** Nota 0-100 como la del perfil «Content Site» de la web: aprobadas / comprobadas. */
export function score(scan: Pick<ParsedScan, "passed" | "total">): number {
  return scan.total ? Math.round((scan.passed / scan.total) * 100) : 0;
}

/**
 * Comprobaciones que pasaban antes y fallan en los dos escaneos más recientes.
 * `history` va del más reciente al más antiguo y es del mismo perfil.
 */
export function regressions(history: Pick<ParsedScan, "checks">[]): string[] {
  if (history.length < 3) return [];
  const [latest, previous, ...older] = history;
  const lastGood = older.find(Boolean);
  if (!lastGood) return [];
  return Object.keys(latest.checks).filter(
    (k) => latest.checks[k] === "fail" && previous.checks[k] === "fail" && lastGood.checks[k] === "pass",
  );
}

type Fetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function fetchScan(profile: Profile, fetcher: Fetcher = fetch, attempts = 3): Promise<ParsedScan> {
  const body: Record<string, unknown> = { url: SCAN_TARGET };
  if (profile === "content") body.enabledChecks = [...CONTENT_CHECKS];
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetcher(SCAN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`escáner respondió ${res.status}`);
      return parseScan(await res.json());
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5_000 * (i + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface CollectDeps {
  fetchScan?: typeof fetchScan;
  alert?: typeof recordAlert;
}

export async function collectAgentReadiness(deps: CollectDeps = {}): Promise<Record<Profile, ParsedScan>> {
  const scan = deps.fetchScan ?? fetchScan;
  const alert = deps.alert ?? recordAlert;
  const out = {} as Record<Profile, ParsedScan>;
  for (const profile of ["content", "all"] as const) {
    const result = await scan(profile);
    await prisma.agentReadinessScan.create({
      data: {
        profile,
        level: result.level,
        levelName: result.levelName,
        passed: result.passed,
        total: result.total,
        checks: result.checks,
        nextLevel: result.nextLevel ?? undefined,
      },
    });
    out[profile] = result;

    const rows = await prisma.agentReadinessScan.findMany({
      where: { profile },
      orderBy: { scannedAt: "desc" },
      take: 10,
      select: { checks: true },
    });
    const lost = regressions(rows.map((r) => ({ checks: r.checks as Record<string, CheckStatus> })));
    if (lost.length) {
      await alert({
        type: "agent-readiness-regression",
        subject: `Agent readiness (${profile}): deja de pasar ${lost.join(", ")}`,
        body:
          `isitagentready.com marca como fallidas en los dos últimos escaneos comprobaciones que antes pasaban: ${lost.join(", ")}. ` +
          `Nota actual ${score(result)}/100, nivel ${result.level} (${result.levelName}). ` +
          `Revisar robots.txt, cabeceras y /.well-known de la web.`,
      });
    }
  }
  return out;
}
