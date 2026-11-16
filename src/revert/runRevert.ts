// src/revert/runRevert.ts
// Sonda de los cambios SEO desplegados y reversión determinista (§15.3, anexo
// C.5 paso 5). Corre en el Mac con el puente (inicio de sesión de gh del
// propietario, nunca la IA):
//   1. detectRegressions: por cada cambio A1 fusionado y desplegado en los
//      últimos 7 días, sonda de su página; si se rompe, hallazgo urgente
//      change-regression (operación revert-change), sin pasar por Órbita.
//   2. runReverts: git revert del commit seo(<id8>) en un worktree temporal,
//      comprobación de que es el inverso exacto, PR con la etiqueta seo-revert
//      y, con la CI en verde, squash a main. Exenta del freno: solo deshace.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../db";
import { recordAlert } from "../alerts/recordAlert";
import { isExactInverse } from "../brake/brake";
import { taskId8 } from "../bridge/guard";
import { isPrivateUrl } from "../privacy/sitePrivacy";
import { NOINDEX_PAGES, REGRESSION_TYPE, REVERT_LABEL, findChangeCommit, parseHead, regressionKey, regressionReasons, revertBranch, type PageProbe } from "./regression";

const DAY_MS = 24 * 60 * 60 * 1000;
const APP_DIR = () => process.env.WEDDING_INVITE_2_DIR ?? join(__dirname, "..", "..", "..", "wedding-invite-2");
const env = () => ({ ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "", GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" });
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: env(), timeout: 5 * 60_000 }).trim();

export type Prober = (url: string) => Promise<PageProbe>;

export const httpProbe: Prober = async (url) => {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}seo-probe=${Date.now()}`, { headers: { "user-agent": "seo-agent-probe/1.0" }, redirect: "manual" });
  const head = parseHead(res.status < 300 ? await res.text() : "");
  return { status: res.status, ...head };
};

/** Cambios A1 fusionados y desplegados (7 días) cuya página ya no está bien: abre change-regression. */
export async function detectRegressions(deps: { now?: Date; probe?: Prober } = {}): Promise<number> {
  const now = deps.now ?? new Date();
  const probe = deps.probe ?? httpProbe;
  const links = await prisma.seoTaskLink.findMany({ where: { autonomy: "A1", closeReason: "done", closedAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } } });
  let opened = 0;
  for (const link of links) {
    const id8 = taskId8(link.orbitaTaskId);
    const url = link.page;
    if (!url || (!NOINDEX_PAGES.has(url) && isPrivateUrl(url))) continue;
    const deployed = await prisma.deployEvent.findFirst({ where: { seoChangeIds: { has: id8 } } });
    if (!deployed) continue;
    const stableKey = regressionKey(id8);
    if (await prisma.opportunity.findUnique({ where: { stableKey } })) continue;
    let reasons: string[];
    try {
      reasons = regressionReasons(url, await probe(url));
    } catch (e) {
      reasons = [`no responde (${(e as Error).message.slice(0, 80)})`];
    }
    if (!reasons.length) continue;
    await prisma.opportunity.create({
      data: {
        source: "seo-probe",
        findingType: REGRESSION_TYPE,
        stableKey,
        sourceRefId: id8,
        title: `Regresión del cambio seo(${id8}): ${reasons.join(", ")}`,
        detail: { changeId: id8, url, reasons, deployedSha: deployed.commitSha },
        page: url,
        operation: "revert-change",
        autonomy: "A1",
        lane: "urgent",
        severity: "critical",
        impactScore: 100,
        confidenceScore: 1,
        effortScore: 1,
        priorityScore: 1000,
        status: "open",
        // queued: la revierte este módulo, el puente no crea tarea en Órbita
        state: "queued",
        stateChangedAt: now,
      },
    });
    await recordAlert({ type: "seo-change-regression", subject: `Regresión del cambio SEO ${id8}: se revierte`, body: `${url}: ${reasons.join(", ")}. Se abre la reversión determinista.` });
    opened += 1;
  }
  return opened;
}

interface RevertDetail {
  changeId: string;
  prUrl?: string;
  failed?: string;
}

async function setDetail(id: string, detail: object, extra: Record<string, unknown> = {}) {
  await prisma.opportunity.update({ where: { id }, data: { detail: detail as object, ...extra } });
}

/** Una pasada: abre la reversión de cada regresión pendiente o fusiona la que ya tiene la CI en verde. */
export async function runReverts(deps: { now?: Date } = {}): Promise<string[]> {
  const now = deps.now ?? new Date();
  const notes: string[] = [];
  const opps = await prisma.opportunity.findMany({ where: { findingType: REGRESSION_TYPE, status: "open" } });
  if (!opps.length) return notes;
  const dir = APP_DIR();
  run("git", ["fetch", "-q", "origin", "main"], dir);
  const log = run("git", ["log", "origin/main", "-n", "400", "--format=%H%x09%s"], dir)
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ sha: l.split("\t")[0], subject: l.split("\t").slice(1).join("\t") }));
  const resolved = { status: "resolved", state: "resolved", stateChangedAt: now };

  for (const opp of opps) {
    const d = (opp.detail ?? {}) as unknown as RevertDetail;
    if (d.failed || !d.changeId) continue;
    const { sha, reverted } = findChangeCommit(log, d.changeId);
    if (reverted) {
      await setDetail(opp.id, d, resolved);
      notes.push(`${d.changeId}: revertido en main`);
      continue;
    }
    if (!sha) continue;

    if (d.prUrl) {
      const pr = JSON.parse(run("gh", ["pr", "view", d.prUrl, "--json", "state,headRefOid,statusCheckRollup"], dir)) as {
        state: string;
        headRefOid: string;
        statusCheckRollup: { status?: string; conclusion?: string; state?: string }[];
      };
      if (pr.state === "MERGED") {
        await setDetail(opp.id, d, resolved);
        continue;
      }
      if (pr.state !== "OPEN") {
        await setDetail(opp.id, { ...d, failed: "PR de reversión cerrado sin fusionar" });
        continue;
      }
      const checks = pr.statusCheckRollup;
      const pending = !checks.length || checks.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED");
      if (pending) continue;
      const red = checks.some((c) => (c.conclusion && !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(c.conclusion)) || c.state === "FAILURE" || c.state === "ERROR");
      if (red) {
        await setDetail(opp.id, { ...d, failed: "CI de la reversión en rojo" });
        await recordAlert({ type: "seo-revert-failed", subject: `La reversión de ${d.changeId} tiene la CI en rojo`, body: `${d.prUrl}: hay que mirarla a mano.` });
        continue;
      }
      run("gh", ["pr", "merge", d.prUrl, "--squash", "--match-head-commit", pr.headRefOid, "--delete-branch"], dir);
      notes.push(`${d.changeId}: reversión fusionada ${d.prUrl}`);
      await recordAlert({ type: "seo-revert-merged", subject: `Cambio SEO ${d.changeId} revertido`, body: `${d.prUrl} fusionado; se despliega con la CI de main.` });
      continue;
    }

    // Reversión nueva: worktree temporal desde origin/main, git revert y comprobación del inverso exacto.
    const wt = join(mkdtempSync(join(tmpdir(), "seo-revert-")), "wt");
    const branch = revertBranch(d.changeId);
    try {
      run("git", ["worktree", "add", "-q", "-B", branch, wt, "origin/main"], dir);
      try {
        run("git", ["revert", "--no-edit", sha], wt);
      } catch {
        try {
          run("git", ["revert", "--abort"], wt);
        } catch {}
        await setDetail(opp.id, { ...d, failed: "la reversión choca con cambios posteriores" });
        await recordAlert({ type: "seo-revert-failed", subject: `No se puede revertir ${d.changeId} sola`, body: "git revert choca con cambios posteriores: hay que revertirlo a mano." });
        continue;
      }
      const original = run("git", ["show", "--format=", sha], wt);
      const inverse = run("git", ["show", "--format=", "HEAD"], wt);
      if (!isExactInverse(original, inverse)) {
        await setDetail(opp.id, { ...d, failed: "la reversión no es el inverso exacto" });
        continue;
      }
      run("git", ["push", "-q", "-f", "-u", "origin", `${branch}:${branch}`], wt);
      const subject = run("git", ["log", "-1", "--format=%s"], wt);
      const prUrl = run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", subject, "--body", `Reversión determinista de seo(${d.changeId}) por regresión: ${opp.title}`, "--label", REVERT_LABEL], wt);
      await setDetail(opp.id, { ...d, prUrl });
      notes.push(`${d.changeId}: PR de reversión ${prUrl}`);
    } finally {
      try {
        run("git", ["worktree", "remove", "--force", wt], dir);
      } catch {}
      rmSync(join(wt, ".."), { recursive: true, force: true });
    }
  }
  return notes;
}
