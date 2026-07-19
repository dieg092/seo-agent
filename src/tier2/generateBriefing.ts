// src/tier2/generateBriefing.ts
import { prisma } from "../db";
import { getTier } from "../tier1/tierAssignment";
import { fetchArticleText } from "../embeddings/fetchArticleContent";
import { getEnv } from "../env";
import type { FindingType } from "../prioritization/types";

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
      const detail = opportunity.detail as { sourceSlug: string; targetSlug: string; similarity: number };
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
