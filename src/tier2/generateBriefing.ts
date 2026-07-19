// src/tier2/generateBriefing.ts
import { prisma } from "../db";
import { getTier } from "../tier1/tierAssignment";
import { fetchArticleText } from "../embeddings/fetchArticleContent";
import { getEnv } from "../env";
import type { FindingType } from "../prioritization/types";

type InternalLinkDetail = { sourceSlug: string; targetSlug: string; similarity: number };

// `detail` is a Prisma `Json` column with no DB-level schema enforcement, so a row can
// legitimately end up with a null or malformed value at runtime. Guard against that
// instead of trusting the cast, so one bad record can't abort the whole briefing.
function isValidInternalLinkDetail(detail: unknown): detail is InternalLinkDetail {
  if (typeof detail !== "object" || detail === null) return false;
  const { sourceSlug, targetSlug, similarity } = detail as Record<string, unknown>;
  return (
    typeof sourceSlug === "string" &&
    sourceSlug.length > 0 &&
    typeof targetSlug === "string" &&
    targetSlug.length > 0 &&
    typeof similarity === "number"
  );
}

export async function generateBriefing(deps: {
  getArticleText?: typeof fetchArticleText;
} = {}): Promise<string> {
  const getArticleText = deps.getArticleText ?? fetchArticleText;
  const baseUrl = (() => {
    try {
      return getEnv("SITE_BASE_URL");
    } catch {
      return "https://miwebdeboda.com";
    }
  })();

  const openOpportunities = await prisma.opportunity.findMany({
    where: { status: "open" },
    orderBy: { priorityScore: "desc" },
  });

  const tier2Opportunities = openOpportunities.filter((o) => getTier(o.findingType as FindingType) === 2);

  if (tier2Opportunities.length === 0) {
    return "# Briefing Tier 2 — SEO Agent\n\nNo hay oportunidades Tier 2 abiertas ahora mismo.\n";
  }

  const sections: string[] = [`# Briefing Tier 2 — SEO Agent\n`, `${tier2Opportunities.length} oportunidades para revisar.\n`];

  for (const opportunity of tier2Opportunities) {
    sections.push(`## ${opportunity.title}\n`);
    sections.push(`- Tipo: ${opportunity.findingType}`);
    sections.push(`- Prioridad: ${opportunity.priorityScore.toFixed(1)}\n`);

    if (opportunity.findingType === "internal-link-suggestion") {
      if (!isValidInternalLinkDetail(opportunity.detail)) {
        sections.push(
          `> ⚠️ Datos malformados para esta oportunidad (id: ${opportunity.id}, sourceRefId: ${opportunity.sourceRefId}). Se omite el contenido de los artículos; revisar el registro en la base de datos.\n`,
        );
        continue;
      }

      const detail = opportunity.detail;
      const sourceUrl = `${baseUrl}/blog/${detail.sourceSlug}`;
      const targetUrl = `${baseUrl}/blog/${detail.targetSlug}`;

      const sourceText = await getArticleText({ url: sourceUrl });
      const targetText = await getArticleText({ url: targetUrl });

      sections.push(`### Artículo origen (${detail.sourceSlug})\n`);
      sections.push(sourceText.slice(0, 2000));
      sections.push(`\n\n### Artículo destino (${detail.targetSlug})\n`);
      sections.push(targetText.slice(0, 2000));
      sections.push("\n");
    }
  }

  return sections.join("\n");
}
