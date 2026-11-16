// scripts/seo-canary-task.ts
// Tarea canario A1 (anexo D, pruebas 8 y 14): una tarea SEO automática real,
// de punta a punta (Órbita → PR seo-auto → CI → guarda → revisión → fusión →
// despliegue), que solo cambia el title y la description de /seo-canario, una
// página técnica sin indexar. Crea su Opportunity, el enlace y la tarea con
// `orbita-task add --auto`. Si ya hay un canario abierto, no crea otro.
//   tsx scripts/seo-canary-task.ts [--dry-run]
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/db";
import { readControl } from "../src/brake/control";
import { buildContract, renderDescription, renderPrompt, taskTitle, validateContract } from "../src/bridge/contract";
import { orbitaCli } from "../src/bridge/orbitaCli";

export const CANARY_TYPE = "seo-canary";
const PAGE = "https://miwebdeboda.com/seo-canario";

async function main(): Promise<number> {
  const dry = process.argv.includes("--dry-run");
  const control = await readControl();
  if (!control || control.masterSwitch !== "on" || control.brakeState === "tripped") {
    console.error("Interruptor apagado, freno activo o SeoControl ilegible: no se crea el canario.");
    return 1;
  }
  const open = await prisma.seoTaskLink.findFirst({ where: { findingType: CANARY_TYPE, closedAt: null } });
  if (open) {
    console.log(`Ya hay un canario abierto: tarea ${open.orbitaTaskId}`);
    return 0;
  }

  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const title = `Canario SEO ${day} | miwebdeboda.com`;
  const description = `Comprobación técnica del agente SEO del ${day}. No contiene información para el público.`;
  const stableKey = createHash("sha256").update(`${CANARY_TYPE}:${now.toISOString()}`).digest("hex");
  const detail = { url: PAGE, file: "src/app/seo-canario/page.tsx", expectedTitle: title, expectedDescription: description };
  const objective = `Cambiar el title de /seo-canario a «${title}» y la description a «${description}»`;

  const opp = {
    id: randomUUID(),
    stableKey,
    findingType: CANARY_TYPE,
    title: objective,
    detail,
    page: PAGE,
    operation: "meta-title-description",
    autonomy: "A1",
    lane: "technical",
    severity: "low",
  };
  const contract = {
    ...buildContract(opp, { now, changeId: randomUUID() }),
    publishPolicy: "auto-merge-if-green" as const,
    acceptance: [
      `en src/app/seo-canario/page.tsx, metadata.title es exactamente «${title}» y metadata.description es exactamente «${description}»`,
      "no cambia nada más: ni robots (sigue index: false, follow: false), ni la canónica, ni el contenido de la página",
      "diff dentro de allowedPaths y de los límites",
    ],
  };
  const errors = validateContract(contract, { allowAutoMerge: true });
  if (errors.length) {
    console.error(`Contrato no válido: ${errors.join(", ")}`);
    return 1;
  }
  if (dry) {
    console.log(JSON.stringify({ title: taskTitle(contract), prompt: renderPrompt(contract) }, null, 2));
    return 0;
  }

  await prisma.opportunity.create({
    data: {
      id: opp.id,
      source: CANARY_TYPE,
      findingType: CANARY_TYPE,
      stableKey,
      sourceRefId: "seo-canario",
      title: objective,
      detail,
      page: PAGE,
      operation: opp.operation,
      autonomy: "A1",
      lane: "technical",
      severity: "low",
      impactScore: 1,
      confidenceScore: 1,
      effortScore: 1,
      priorityScore: 0,
      status: "open",
      state: "queued",
      stateChangedAt: now,
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "seo-canary-"));
  try {
    const metadataFile = join(dir, "metadata.json");
    writeFileSync(metadataFile, JSON.stringify({ seo: { ...contract, stage: "run" } }));
    const { id } = await orbitaCli.add({
      title: taskTitle(contract),
      description: renderDescription(contract),
      priority: "medium",
      labels: ["seo", "seo-agent"],
      metadataFile,
      dedupeKey: stableKey,
      aiPrompt: renderPrompt(contract),
      auto: true,
    });
    await prisma.seoTaskLink.create({
      data: {
        opportunityId: opp.id,
        stableKey,
        orbitaTaskId: id,
        findingType: CANARY_TYPE,
        operation: opp.operation,
        page: PAGE,
        lane: "technical",
        autonomy: "A1",
        contract: contract as unknown as object,
        expiresAt: new Date(contract.expiresAt),
      },
    });
    console.log(`Canario creado: tarea ${id} (${title})`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .catch((e) => {
    console.error(e);
    return 1;
  })
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  });
