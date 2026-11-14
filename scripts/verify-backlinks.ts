// scripts/verify-backlinks.ts
// Comprueba los enlaces de BacklinkOpportunity en estado «conseguido» (o con
// verifiedLink): descarga la página, mira que enlace a miwebdeboda.com y
// guarda el resultado. Una petición cada 5 s y respetando robots.txt (§16.3).
// Alta manual de una oportunidad:
//   tsx scripts/verify-backlinks.ts add --domain x.com --kind blog --relevance alta --reason "…" --probability media [--page URL]
import { prisma } from "../src/db";
import { checkBacklink } from "../src/strategy/backlinks";
import { parseRobotsTxt } from "../src/crawler/robotsTxt";
import { recordAlert } from "../src/alerts/recordAlert";

const UA = "miwebdeboda-seo-agent/1.0 (+https://miwebdeboda.com)";
const DELAY_MS = 5000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function allowedByRobots(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const res = await fetch(`${u.origin}/robots.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return true;
    return parseRobotsTxt(await res.text(), UA).isAllowed(u.pathname + u.search);
  } catch {
    return true;
  }
}

async function verify(): Promise<number> {
  const rows = await prisma.backlinkOpportunity.findMany({ where: { OR: [{ status: "conseguido" }, { verifiedLink: { not: null } }] } });
  let ok = 0;
  let lost = 0;
  for (const [i, row] of rows.entries()) {
    const url = row.verifiedLink ?? row.candidatePage;
    if (!url) continue;
    if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    if (!(await allowedByRobots(url))) continue;
    let found = false;
    let follow = false;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const c = checkBacklink(await res.text());
        found = c.found;
        follow = c.found && c.follow;
      }
    } catch {
      found = false;
    }
    await prisma.backlinkOpportunity.update({
      where: { id: row.id },
      data: { lastCheckedAt: new Date(), ...(found ? { verifiedAt: new Date(), outcome: follow ? "enlace activo" : "enlace nofollow" } : { outcome: "enlace no encontrado" }) },
    });
    if (found) ok += 1;
    else if (row.verifiedAt) {
      lost += 1;
      await recordAlert({ type: "backlink-lost", subject: `Ya no aparece el enlace de ${row.domain}`, body: `La página ${url} no enlaza a miwebdeboda.com en la última comprobación.` });
    }
  }
  console.log(`Backlinks: ${rows.length} comprobados, ${ok} activos, ${lost} perdidos`);
  return 0;
}

async function add(): Promise<number> {
  const domain = arg("domain");
  const kind = arg("kind");
  const relevance = arg("relevance");
  const reason = arg("reason");
  const probability = arg("probability");
  if (!domain || !kind || !relevance || !reason || !probability) {
    console.error("Faltan --domain, --kind, --relevance, --reason o --probability");
    return 1;
  }
  const candidatePage = arg("page") ?? null;
  const existing = await prisma.backlinkOpportunity.findFirst({ where: { domain, candidatePage } });
  const data = { kind, relevance, reason, probability, risks: arg("risks") ?? null };
  const row = existing
    ? await prisma.backlinkOpportunity.update({ where: { id: existing.id }, data })
    : await prisma.backlinkOpportunity.create({ data: { domain, candidatePage, ...data } });
  console.log(`BacklinkOpportunity ${row.id} (${row.status})`);
  return 0;
}

(process.argv[2] === "add" ? add() : verify())
  .catch((error) => {
    console.error("verify-backlinks failed:", error);
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  });
