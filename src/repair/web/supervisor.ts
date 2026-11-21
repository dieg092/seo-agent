// src/repair/web/supervisor.ts
// Autorreparación de la WEB (plan de Codex, 2026-11-21), dentro del mismo supervisor seo-repair:
// comparte la tabla RepairIncident, el tope de 2 ejecuciones del modelo al día, el presupuesto de
// fondo y la regla de «una reparación activa a la vez» (seo-agent o web).
//
// Cada pasada:
//   1. observeWeb: lee las ejecuciones terminadas de cada fuente (CI de wi2, lighthouse, deploy,
//      health checks, monitores), clasifica sin modelo y relanza una vez lo transitorio; lo que
//      vuelve a verde se cierra solo y un fallo que desaparece al relanzar cuenta como intermitente;
//   2. repairWeb: como mucho UNA incidencia de código: copia aislada de wi2 → puerta local antes
//      (reproduce) → agente aislado → guarda del diff (nada protegido) → puerta local después →
//      rama ia/reparacion-* + PR + CI completa con E2E lanzada a mano;
//   3. advanceWebPrs: con la CI completa del commit exacto en verde y la rama al día con main,
//      squash; la CI de main pide el despliegue sola (la puerta de miwebdeboda-deploy no cambia);
//   4. verifyWeb: CI de main del commit fusionado, despliegue y una ejecución sana de la fuente
//      original; si la CI de ese commit o el smoke del despliegue fallan, PR de reversión.
import { prisma } from "../../db";
import type { DiffFile } from "../guard";
import { parseReport, safeCommitMessage } from "../contract";
import type { AgentRun } from "../sandbox";
import { MAX_RUNS_PER_DAY, MAX_RUNS_PER_INCIDENT, RETRY_GAP_MS, runsToday, type Workspace } from "../supervisor";
import { classifyWebFailure, FLAKY, WEB_SOURCES, webIncidentKey, type WebSource } from "./classify";
import { webRepairPrompt } from "./contract";
import type { PrState, Run } from "./github";
import { guardWebDiff } from "./guard";
import { safeText } from "./privacy";

const HOUR = 3_600_000;
export const WEB_VERIFY_MS = 72 * HOUR;
export const BRANCH_CI_TIMEOUT_MS = 4 * HOUR;
export const MAX_BRANCH_UPDATES = 3;
/** Un transitorio que no se va en 3 ejecuciones durante ≥ 6 h ya no se espera más: se avisa. */
export const TRANSIENT_GIVE_UP = { occurrences: 3, spanMs: 6 * HOUR };
/** Estados de incidencias que bloquean empezar otra reparación (web o seo-agent). */
export const ACTIVE_STATUSES = ["running", "merged-pending-update", "pr-open"];

export interface WebDeps {
  now: () => Date;
  notify: (a: { type: string; subject: string; body: string }) => Promise<void>;
  reserve: (now: Date) => Promise<void>;
  runs: (s: WebSource) => Run[];
  failure: (s: WebSource, r: Run) => { failedSteps: string[]; lines: string[] };
  retry: (s: WebSource, r: Run) => boolean;
  createWorkspace: () => Workspace;
  runAgent: (dir: string, prompt: string) => Promise<AgentRun>;
  diff: (dir: string) => DiffFile[];
  gate: (dir: string) => { ok: boolean; detail: string };
  isProtected: (path: string) => boolean;
  pushPr: (dir: string, branch: string, message: string, body: string) => { number: number; url: string; head: string };
  pr: (n: number) => PrState;
  updateBranch: (n: number) => void;
  dispatchCi: (branch: string) => void;
  branchCi: (branch: string, head: string) => Run | null;
  merge: (n: number, head: string, subject: string) => string;
  close: (n: number) => void;
  revertInto: (dir: string, sha: string) => void;
}

/** Cursor: última ejecución vista por componente («id:intento»). */
export type WebCursor = Record<string, string>;

type Incident = Awaited<ReturnType<typeof prisma.repairIncident.findFirstOrThrow>>;
interface WebResult {
  runs?: { at: string; verdict: string; detail?: string }[];
  lastRun?: { id: number; attempt: number; sha: string; url: string; at: string };
  failedSteps?: string[];
  lines?: string[];
  reason?: string;
  retry?: { at: string; runId: number; attempt: number };
  flaky?: string[];
  pr?: { number: number; url: string; branch: string; head: string; dispatchedAt: string; updates: number; kind: "fix" | "revert"; message: string };
  mergedAt?: string;
  revertOf?: string;
  resolvedBy?: string;
  founderStep?: string;
}

const res = (i: Incident): WebResult => ((i.result as WebResult | null) ?? {}) as WebResult;
const sourceOf = (component: string) => WEB_SOURCES.find((s) => s.component === component);
const runKey = (r: Run) => `${r.id}:${r.attempt}`;
const newer = (r: Run, cursor?: string) => {
  if (!cursor) return true;
  const [id, at] = cursor.split(":").map(Number);
  return r.id > id || (r.id === id && r.attempt > at);
};

async function save(i: Incident, data: Record<string, unknown>, result?: Partial<WebResult>) {
  return prisma.repairIncident.update({ where: { id: i.id }, data: { ...data, ...(result ? { result: { ...res(i), ...result } as object } : {}) } });
}

async function tellFounder(i: Incident, step: string, deps: Pick<WebDeps, "notify" | "now">, why = "necesita algo que solo puedes hacer tú") {
  if (i.notifiedAt) return;
  await deps.notify({ type: "seo-repair-founder", subject: `Autorreparación web: ${i.component} ${why}`, body: `${step}\nIncidencia ${i.id.slice(0, 8)} (vista ${i.occurrences} vez/veces).` });
  await prisma.repairIncident.update({ where: { id: i.id }, data: { status: "escalated", notifiedAt: deps.now() } });
}

/** 1. Observación y clasificación. Devuelve el cursor nuevo y líneas para el log. */
export async function observeWeb(cursor: WebCursor, deps: Pick<WebDeps, "now" | "notify" | "runs" | "failure" | "retry">): Promise<{ cursor: WebCursor; log: string[] }> {
  const next: WebCursor = { ...cursor };
  const log: string[] = [];
  for (const s of WEB_SOURCES) {
    let runs: Run[];
    try {
      runs = deps.runs(s);
    } catch (e) {
      log.push(`${s.component}: no se pudo leer (${safeText(String((e as Error).message), 120)})`);
      continue;
    }
    // Primera pasada: solo la última ejecución (no se reprocesa el histórico).
    const todo = (cursor[s.component] ? runs.filter((r) => newer(r, cursor[s.component])) : runs.slice(0, 1)).sort((a, b) => a.id - b.id || a.attempt - b.attempt);
    for (const r of todo) {
      if (r.conclusion === "success") log.push(...(await onHealthy(s, r, deps)));
      else if (r.conclusion && r.conclusion !== "skipped" && r.conclusion !== "neutral") log.push(await onFailure(s, r, deps));
      next[s.component] = runKey(r);
    }
  }
  return { cursor: next, log };
}

async function onHealthy(s: WebSource, r: Run, deps: Pick<WebDeps, "now" | "notify">): Promise<string[]> {
  const log: string[] = [];
  const at = new Date(r.createdAt);
  const open = await prisma.repairIncident.findMany({ where: { component: s.component, status: { in: ["open", "waiting", "escalated"] } } });
  for (const i of open) {
    const retried = res(i).retry;
    // Volvió a verde al relanzarlo un fallo de código: intermitente, no se repara aún.
    if (i.kind === "code" && i.status === "waiting" && retried) {
      const since = deps.now().getTime() - FLAKY.windowMs;
      const flaky = [...(res(i).flaky ?? []).filter((t) => Date.parse(t) >= since), deps.now().toISOString()];
      const persistent = flaky.length >= FLAKY.occurrences;
      await save(i, persistent ? { status: "open", nextAttemptAt: deps.now() } : { status: "resolved", notifiedAt: null }, { flaky, retry: undefined, resolvedBy: persistent ? undefined : "intermitente: pasó al relanzarlo" });
      log.push(`${s.component} ${i.id.slice(0, 8)}: ${persistent ? `intermitente ${flaky.length} veces en 14 días → a reparar` : "intermitente (pasó al relanzarlo)"}`);
      continue;
    }
    if (i.lastSeenAt <= at) {
      await save(i, { status: "resolved", notifiedAt: null }, { retry: undefined, resolvedBy: `volvió a verde (${r.createdAt.slice(0, 16)} UTC)` });
      log.push(`${s.component} ${i.id.slice(0, 8)}: vuelve a verde`);
    }
  }
  return log;
}

async function onFailure(s: WebSource, r: Run, deps: Pick<WebDeps, "now" | "notify" | "failure" | "retry">): Promise<string> {
  const now = deps.now();
  const f = deps.failure(s, r);
  const c = classifyWebFailure({ component: s.component, conclusion: r.conclusion ?? "failure", ...f });
  const key = webIncidentKey(s.component, c.signature);
  const lastRun = { id: r.id, attempt: r.attempt, sha: r.headSha, url: r.url, at: r.createdAt };
  const base: Partial<WebResult> = { lastRun, failedSteps: f.failedSteps, lines: f.lines.slice(0, 40), reason: c.reason, founderStep: c.founderStep };
  const seen = new Date(r.createdAt);
  let i = await prisma.repairIncident.findUnique({ where: { key } });
  const isNew = !i;
  if (!i) {
    i = await prisma.repairIncident.create({
      data: { key, alertType: `web-${c.kind}`, component: s.component, signature: c.signature, kind: c.kind, status: "waiting", firstSeenAt: seen, lastSeenAt: seen, nextAttemptAt: now, result: base as object },
    });
  } else {
    const reopened = i.status === "resolved" || i.status === "reverted";
    i = await prisma.repairIncident.update({
      where: { id: i.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: seen > i.lastSeenAt ? seen : i.lastSeenAt,
        ...(reopened ? { status: "waiting", notifiedAt: null, nextAttemptAt: now, attempts: i.status === "reverted" ? i.attempts : 0 } : {}),
        result: { ...res(i), ...base, ...(reopened ? { retry: undefined } : {}) } as object,
      },
    });
  }
  const tag = `${s.component} ${i.id.slice(0, 8)} (${c.kind}, ${c.reason})`;
  // Lo que ya está en manos de una reparación no cambia de estado aquí.
  if (["running", "pr-open", "verifying", "merged-pending-update"].includes(i.status)) return `${tag}: visto otra vez durante la reparación`;
  if (i.status === "escalated" && i.notifiedAt) return `${tag}: ya avisado`;

  if (c.kind === "founder") {
    await tellFounder(i, c.founderStep!, deps);
    return `${tag}: avisado al fundador`;
  }
  const retried = res(i).retry;
  // El resultado del relanzamiento: otro intento de la misma ejecución (rerun) o una ejecución posterior.
  const retryOutcome = !!retried && (r.id !== retried.runId || r.attempt > retried.attempt);
  // Primer fallo de esta generación: relanzar una vez (transitorio, externo y código: así se ve si es intermitente).
  if (!retried && s.retry !== "none") {
    const ok = deps.retry(s, r);
    await save(i, { status: "waiting" }, { retry: { at: now.toISOString(), runId: r.id, attempt: r.attempt } });
    return `${tag}: ${ok ? "relanzado" : "no se pudo relanzar"}${isNew ? " (nuevo)" : ""}`;
  }
  if (!retryOutcome && retried) return `${tag}: esperando al relanzamiento`;

  // Ha fallado también al relanzarlo (o la fuente no se relanza).
  if (c.kind === "code") {
    if (!s.repairable) {
      await tellFounder(i, `${s.component} falla (${c.reason}) y no es algo que pueda arreglar solo. Abre Claude Code y dile «revisa la incidencia ${i.id.slice(0, 8)} de autorreparación web».`, deps, "falla y no se repara sola");
      return `${tag}: no reparable, avisado`;
    }
    await save(i, { status: "open", nextAttemptAt: now });
    return `${tag}: reproducible → a reparar`;
  }
  if (c.kind === "external") {
    await tellFounder(i, c.founderStep!, deps, "falla por un servicio externo");
    return `${tag}: externo, avisado`;
  }
  // transitorio que persiste
  if (i.occurrences >= TRANSIENT_GIVE_UP.occurrences && i.lastSeenAt.getTime() - i.firstSeenAt.getTime() >= TRANSIENT_GIVE_UP.spanMs) {
    await tellFounder(i, `${s.component} lleva ${i.occurrences} fallos de infraestructura seguidos (${c.reason}) y no se recupera solo. Abre Claude Code y dile «revisa la incidencia ${i.id.slice(0, 8)} de autorreparación web».`, deps, "no se recupera sola");
    return `${tag}: transitorio persistente, avisado`;
  }
  await save(i, { status: "waiting" }, { retry: undefined });
  return `${tag}: transitorio, se espera a la siguiente ejecución`;
}

function runsOf(i: Incident) {
  return res(i).runs ?? [];
}

async function finishAttempt(i: Incident, verdict: string, detail: string, deps: Pick<WebDeps, "now" | "notify">, attempt: number) {
  const fresh = await prisma.repairIncident.findUniqueOrThrow({ where: { id: i.id } });
  const retry = attempt < MAX_RUNS_PER_INCIDENT;
  const now = deps.now();
  await save(fresh, { status: retry ? "open" : "escalated", nextAttemptAt: retry ? new Date(now.getTime() + RETRY_GAP_MS) : null, ...(retry ? {} : { notifiedAt: now }) }, { runs: [...runsOf(fresh), { at: now.toISOString(), verdict, detail: safeText(detail, 600) }], pr: undefined });
  if (!retry) {
    await deps.notify({
      type: "seo-repair-escalated",
      subject: `Autorreparación web: no he podido arreglar ${i.component}`,
      body: `Tras ${attempt} intento(s): ${safeText(detail, 400)}\nNo hace falta que hagas nada ahora: abre Claude Code cuando puedas y dile «revisa la incidencia ${i.id.slice(0, 8)} de autorreparación web».`,
    });
  }
  return `reparación web ${i.id.slice(0, 8)} (${i.component}): ${verdict} — ${safeText(detail, 160)}`;
}

/** 2. Repara como mucho una incidencia web de código. */
export async function repairWeb(deps: WebDeps): Promise<string> {
  const now = deps.now();
  if (await prisma.repairIncident.findFirst({ where: { status: { in: ACTIVE_STATUSES } } })) return "reparación web: hay otra en curso";
  const inc = await prisma.repairIncident.findFirst({
    where: { component: { startsWith: "web-" }, kind: "code", status: "open", attempts: { lt: MAX_RUNS_PER_INCIDENT }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
    orderBy: [{ occurrences: "desc" }, { firstSeenAt: "asc" }],
  });
  if (!inc) return "reparación web: nada pendiente";
  if ((await runsToday(now)) >= MAX_RUNS_PER_DAY) return "reparación web: tope diario alcanzado";
  try {
    await deps.reserve(now);
  } catch (e) {
    return `reparación web aplazada: ${(e as Error).message}`;
  }
  const claimed = await prisma.repairIncident.updateMany({ where: { id: inc.id, status: "open" }, data: { status: "running", attempts: { increment: 1 } } });
  if (claimed.count === 0) return "reparación web: otra pasada se la ha quedado";
  const attempt = inc.attempts + 1;
  const r = res(inc);
  const ws = deps.createWorkspace();
  try {
    // La puerta local ANTES del cambio dice si el fallo se reproduce sin BD (tipos, lint, unit).
    const before = deps.gate(ws.dir);
    const evidence = [
      `Pasos fallidos: ${(r.failedSteps ?? []).join(" | ") || "(desconocidos)"}`,
      `Clasificación: ${r.reason ?? ""}`,
      `Commit de la ejecución fallida: ${r.lastRun?.sha ?? "?"} (${r.lastRun?.at ?? "?"})`,
      `Líneas de error (saneadas):\n${(r.lines ?? []).join("\n") || "(sin líneas)"}`,
      `Puerta local en el SHA base antes de tocar nada: ${before.ok ? "pasa (el fallo no se reproduce sin BD: mira E2E, build o integración)" : `FALLA:\n${before.detail}`}`,
      (r.flaky ?? []).length ? `Intermitente: pasó al relanzarlo ${(r.flaky ?? []).length} vez/veces en 14 días; arregla la condición de carrera o la espera, sin borrar aserciones.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const run = await deps.runAgent(ws.dir, webRepairPrompt({ incidentId: inc.id.slice(0, 8), source: sourceOf(inc.component)?.workflow ?? inc.component, component: inc.component, baseSha: ws.baseSha, signature: inc.signature, evidence: safeText(evidence, 12_000) }));
    if (!run.ok) return await finishAttempt(inc, "error-agente", run.error ?? "sin detalle", deps, attempt);
    const report = parseReport(run.text);
    if (!report) return await finishAttempt(inc, "salida-invalida", "el agente no devolvió un JSON válido", deps, attempt);
    const files = deps.diff(ws.dir);
    if (report.veredicto !== "reparado") {
      if (files.length) return await finishAttempt(inc, "incoherente", `dice ${report.veredicto} pero cambió ${files.length} fichero(s)`, deps, attempt);
      const fresh = await prisma.repairIncident.findUniqueOrThrow({ where: { id: inc.id } });
      await save(fresh, { status: "escalated" }, { runs: [...runsOf(fresh), { at: now.toISOString(), verdict: report.veredicto, detail: safeText(report.diagnostico, 600) }] });
      await tellFounder(
        { ...fresh, notifiedAt: null },
        `${safeText(report.diagnostico)}\n${report.paso_fundador ? `Qué hacer: ${safeText(report.paso_fundador)}` : `Abre Claude Code y dile «revisa la incidencia ${inc.id.slice(0, 8)} de autorreparación web».`}`,
        deps,
        report.veredicto === "necesita_fundador" ? "necesita algo que solo puedes hacer tú" : "no tiene un arreglo claro"
      );
      return `reparación web ${inc.id.slice(0, 8)}: ${report.veredicto}`;
    }
    const g = guardWebDiff(files, deps.isProtected);
    if (!g.ok) {
      if (g.protectedHit) {
        const fresh = await prisma.repairIncident.findUniqueOrThrow({ where: { id: inc.id } });
        await save(fresh, { status: "escalated" }, { runs: [...runsOf(fresh), { at: now.toISOString(), verdict: "protegido", detail: g.reasons.join("; ").slice(0, 600) }] });
        await tellFounder({ ...fresh, notifiedAt: null }, `El arreglo necesita cambiar ficheros protegidos (${files.filter((f) => deps.isProtected(f.path)).map((f) => f.path).join(", ")}), que no publico solo. Abre Claude Code y dile «revisa la incidencia ${inc.id.slice(0, 8)} de autorreparación web»: lo preparará y te dará la huella.`, deps, "necesita tocar ficheros protegidos");
        return `reparación web ${inc.id.slice(0, 8)}: necesita ficheros protegidos`;
      }
      return await finishAttempt(inc, "guarda", `diff rechazado: ${g.reasons.join("; ")}`, deps, attempt);
    }
    const after = deps.gate(ws.dir);
    if (!after.ok) return await finishAttempt(inc, "puerta-local", after.detail, deps, attempt);
    const message = safeCommitMessage(report.commit, inc.component.replace(/^web-/, ""));
    const branch = `ia/reparacion-${inc.id.slice(0, 8)}-${attempt}`;
    const body = `Reparación automática de la web.\n\nIncidencia ${inc.id.slice(0, 8)} (${inc.component}): ${safeText(r.reason ?? "", 200)}.\n\nFicheros: ${files.map((f) => f.path).join(", ")}.\n\nPuerta local: ${after.detail}. Se fusiona solo cuando la CI completa (con E2E) del commit exacto esté en verde.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`;
    const pr = deps.pushPr(ws.dir, branch, message, body);
    deps.dispatchCi(branch);
    const fresh = await prisma.repairIncident.findUniqueOrThrow({ where: { id: inc.id } });
    await save(fresh, { status: "pr-open", prUrl: pr.url, baseSha: ws.baseSha }, {
      runs: [...runsOf(fresh), { at: now.toISOString(), verdict: "pr", detail: `${pr.url} (${files.length} fichero/s)` }],
      pr: { number: pr.number, url: pr.url, branch, head: pr.head, dispatchedAt: now.toISOString(), updates: 0, kind: "fix", message },
    });
    return `reparación web ${inc.id.slice(0, 8)} (${inc.component}): PR ${pr.url}, CI completa lanzada`;
  } catch (e) {
    return await finishAttempt(inc, "error", String((e as Error).message ?? e), deps, attempt);
  } finally {
    ws.dispose();
  }
}

/** 3. PR abiertos: rama al día, CI completa del commit exacto, squash. */
export async function advanceWebPrs(deps: WebDeps): Promise<string[]> {
  const log: string[] = [];
  const now = deps.now();
  for (const i of await prisma.repairIncident.findMany({ where: { status: "pr-open", component: { startsWith: "web-" } } })) {
    const p = res(i).pr;
    if (!p) continue;
    const isRevert = p.kind === "revert";
    const fail = async (why: string) => {
      deps.close(p.number);
      if (isRevert) {
        await save(i, { status: "escalated", notifiedAt: now }, { pr: undefined });
        await deps.notify({ type: "seo-repair-founder", subject: `Autorreparación web: no se pudo revertir ${i.component}`, body: `La reparación fusionada coincide con un fallo nuevo y la reversión no pasa (${safeText(why, 300)}). Abre Claude Code y dile «revisa la incidencia ${i.id.slice(0, 8)} de autorreparación web».` });
        return `PR ${p.number} (reversión): ${why}`;
      }
      return finishAttempt(i, "ci-rama", why, deps, i.attempts);
    };
    let st: PrState;
    try {
      st = deps.pr(p.number);
    } catch {
      log.push(`PR ${p.number}: no se pudo leer`);
      continue;
    }
    if (st.state === "CLOSED") {
      log.push(await fail("el PR se cerró sin fusionar"));
      continue;
    }
    if (st.state === "MERGED" && st.mergeSha) {
      log.push(await onMerged(i, p, st.mergeSha, deps));
      continue;
    }
    if (st.behind > 0) {
      if (p.updates >= MAX_BRANCH_UPDATES) {
        log.push(await fail(`main avanza más rápido que la CI (${p.updates} actualizaciones)`));
        continue;
      }
      try {
        deps.updateBranch(p.number);
        const head = deps.pr(p.number).head;
        deps.dispatchCi(p.branch);
        await save(i, {}, { pr: { ...p, head, updates: p.updates + 1, dispatchedAt: now.toISOString() } });
        log.push(`PR ${p.number}: rama actualizada con main, CI relanzada`);
      } catch (e) {
        log.push(await fail(`no se pudo poner al día con main: ${safeText(String((e as Error).message), 200)}`));
      }
      continue;
    }
    if (st.head !== p.head) {
      // Alguien empujó a la rama: se vuelve a lanzar la CI completa sobre lo nuevo.
      deps.dispatchCi(p.branch);
      await save(i, {}, { pr: { ...p, head: st.head, dispatchedAt: now.toISOString() } });
      log.push(`PR ${p.number}: commit nuevo en la rama, CI relanzada`);
      continue;
    }
    const run = deps.branchCi(p.branch, p.head);
    if (!run || run.status !== "completed") {
      if (now.getTime() - Date.parse(p.dispatchedAt) > BRANCH_CI_TIMEOUT_MS) log.push(await fail("la CI completa de la rama no termina"));
      else log.push(`PR ${p.number}: esperando a la CI completa`);
      continue;
    }
    if (run.conclusion !== "success") {
      log.push(await fail(`la CI completa de la rama falla (${run.url})`));
      continue;
    }
    try {
      const sha = deps.merge(p.number, p.head, p.message);
      log.push(await onMerged(i, p, sha, deps));
    } catch (e) {
      log.push(`PR ${p.number}: no se pudo fusionar (${safeText(String((e as Error).message), 200)}); se reintenta`);
    }
  }
  return log;
}

async function onMerged(i: Incident, p: NonNullable<WebResult["pr"]>, sha: string, deps: Pick<WebDeps, "now" | "notify">): Promise<string> {
  const now = deps.now();
  if (p.kind === "revert") {
    await save(i, { status: "reverted", notifiedAt: now }, { pr: undefined, revertOf: undefined });
    await deps.notify({ type: "seo-repair-reverted", subject: `Autorreparación web revertida: ${i.component}`, body: `Tras la reparación apareció un fallo nuevo y se ha revertido (${p.url}). La CI de main desplegará la versión anterior sola. La incidencia ${i.id.slice(0, 8)} queda para revisión.` });
    return `PR ${p.number}: reversión fusionada`;
  }
  await save(i, { status: "verifying", mergedSha: sha, verifyUntil: new Date(now.getTime() + WEB_VERIFY_MS) }, { mergedAt: now.toISOString(), pr: { ...p } });
  return `PR ${p.number}: fusionado (${sha.slice(0, 8)}), verificando`;
}

/** 4. Verificación tras fusionar y reversión si empeora. */
export async function verifyWeb(deps: WebDeps): Promise<string[]> {
  const log: string[] = [];
  const now = deps.now();
  for (const v of await prisma.repairIncident.findMany({ where: { status: "verifying", component: { startsWith: "web-" } } })) {
    const r = res(v);
    const mergedAt = Date.parse(r.mergedAt ?? v.updatedAt.toISOString());
    if (!v.mergedSha) continue;
    let ci: Run[] = [];
    let deploys: Run[] = [];
    let own: Run[] = [];
    try {
      ci = deps.runs(sourceOf("web-ci")!);
      deploys = deps.runs(sourceOf("web-deploy")!);
      own = v.component === "web-ci" ? ci : v.component === "web-deploy" ? deploys : deps.runs(sourceOf(v.component)!);
    } catch {
      log.push(`verificación web ${v.id.slice(0, 8)}: no se pudo leer GitHub`);
      continue;
    }
    const after = (x: Run) => Date.parse(x.createdAt) > mergedAt;
    const ciOfMerge = ci.find((x) => x.headSha === v.mergedSha && x.event === "push");
    const deployAfter = deploys.filter(after);
    const regression =
      ciOfMerge && ciOfMerge.conclusion !== "success"
        ? `la CI de main del commit fusionado falla (${ciOfMerge.url})`
        : (() => {
            const bad = deployAfter.find((d) => d.conclusion === "failure");
            if (!bad) return null;
            const steps = deps.failure(sourceOf("web-deploy")!, bad).failedSteps;
            return steps.some((s) => /smoke/i.test(s)) ? `el smoke del despliegue falla tras la reparación (${bad.url})` : null;
          })();
    if (regression) {
      log.push(await startRevert(v, regression, deps));
      continue;
    }
    // El mismo fallo ha vuelto después de fusionar: la reparación no bastó.
    if (v.lastSeenAt.getTime() > mergedAt && own.some((x) => after(x) && x.conclusion !== "success")) {
      const retry = v.attempts < MAX_RUNS_PER_INCIDENT;
      await save(v, { status: retry ? "open" : "escalated", nextAttemptAt: retry ? new Date(now.getTime() + RETRY_GAP_MS) : null, ...(retry ? {} : { notifiedAt: now }) }, { pr: undefined });
      if (!retry) await deps.notify({ type: "seo-repair-escalated", subject: `Autorreparación web: ${v.component} sigue fallando`, body: `La reparación ${v.prUrl ?? ""} no ha bastado y se han agotado los intentos. Abre Claude Code y dile «revisa la incidencia ${v.id.slice(0, 8)} de autorreparación web».` });
      log.push(`verificación web ${v.id.slice(0, 8)}: el fallo vuelve`);
      continue;
    }
    const deployed = deployAfter.find((d) => d.conclusion === "success");
    const healthyOwn = own.find((x) => after(x) && x.conclusion === "success" && (v.component === "web-ci" || v.component === "web-lighthouse" || !deployed || Date.parse(x.createdAt) > Date.parse(deployed.createdAt)));
    const ciOk = ciOfMerge?.conclusion === "success";
    if (ciOk && deployed && healthyOwn) {
      await save(v, { status: "resolved", notifiedAt: null }, { resolvedBy: "reparado y verificado" });
      await deps.notify({ type: "seo-repair-fixed", subject: `Autorreparado: ${v.component}`, body: `Fusionado ${v.prUrl ?? ""}: CI de main en verde, desplegado y ${v.component} vuelve a ir bien.` });
      log.push(`verificación web ${v.id.slice(0, 8)}: resuelta`);
      continue;
    }
    if (v.verifyUntil && now >= v.verifyUntil) {
      await save(v, { status: "resolved", notifiedAt: null }, { resolvedBy: "verificación inconclusa" });
      await deps.notify({ type: "seo-repair-fixed", subject: `Autorreparado (sin confirmar): ${v.component}`, body: `Fusionado ${v.prUrl ?? ""} y sin fallos nuevos en 72 h, pero falta ${!ciOk ? "la CI de main del commit" : !deployed ? "un despliegue" : `una ejecución sana de ${v.component}`}: verificación inconclusa.` });
      log.push(`verificación web ${v.id.slice(0, 8)}: inconclusa`);
    }
  }
  return log;
}

/** PR que revierte exactamente el squash de la reparación; sigue la misma máquina que un arreglo. */
async function startRevert(v: Incident, why: string, deps: WebDeps): Promise<string> {
  const now = deps.now();
  if (await prisma.repairIncident.findFirst({ where: { status: { in: ["running", "pr-open"] }, id: { not: v.id } } })) return `verificación web ${v.id.slice(0, 8)}: ${why}; la reversión espera a que acabe otra reparación`;
  const ws = deps.createWorkspace();
  try {
    deps.revertInto(ws.dir, v.mergedSha!);
    const gate = deps.gate(ws.dir);
    if (!gate.ok) throw new Error(`la reversión no pasa la puerta local: ${gate.detail}`);
    const message = `revierte reparacion de ${v.component.replace(/^web-/, "")}`.slice(0, 60);
    const branch = `ia/reparacion-revert-${v.id.slice(0, 8)}`;
    const pr = deps.pushPr(ws.dir, branch, message, `Revierte ${v.mergedSha!.slice(0, 8)}: ${safeText(why, 300)}.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`);
    deps.dispatchCi(branch);
    await save(v, { status: "pr-open" }, { pr: { number: pr.number, url: pr.url, branch, head: pr.head, dispatchedAt: now.toISOString(), updates: 0, kind: "revert", message }, revertOf: v.mergedSha! });
    return `verificación web ${v.id.slice(0, 8)}: ${why} → PR de reversión ${pr.url}`;
  } catch (e) {
    await save(v, { status: "escalated", notifiedAt: now });
    await deps.notify({ type: "seo-repair-founder", subject: `Autorreparación web: no se pudo revertir ${v.component}`, body: `${safeText(why, 200)}. La reversión automática ha fallado (${safeText(String((e as Error).message), 300)}). Abre Claude Code y dile «revisa la incidencia ${v.id.slice(0, 8)} de autorreparación web».` });
    return `verificación web ${v.id.slice(0, 8)}: reversión fallida`;
  } finally {
    ws.dispose();
  }
}
