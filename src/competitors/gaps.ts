// src/competitors/gaps.ts
// Hallazgos competitor-gap (§16.3): temas que tratan al menos dos competidores y
// que no cubre ninguna de nuestras páginas ni de nuestras consultas de GSC.
// Heurística por embeddings (bge-m3): siempre A2 y contaminado, nunca código.
import { cosine } from "../strategy/keywords";
import type { Finding } from "../prioritization/types";

/** Por debajo de esta similitud con todo lo nuestro, el tema no está cubierto. */
export const COVER_SIMILARITY = 0.62;
/** Páginas de competidores del mismo tema. */
export const TOPIC_SIMILARITY = 0.8;
export const MIN_DOMAINS = 2;
export const MAX_GAP_FINDINGS = 5;

export interface CompetitorTopicPage {
  domain: string;
  url: string;
  path: string;
  title: string | null;
  h1: string | null;
  embedding: number[];
}

/** Texto que se embebe de una página de competidor: solo title y h1. */
export const topicText = (p: { title: string | null; h1: string | null }) => [p.title, p.h1].filter(Boolean).join(" | ").slice(0, 300);

export function extractCompetitorGaps(pages: CompetitorTopicPage[], ours: number[][]): Finding[] {
  const uncovered = pages
    .filter((p) => p.embedding.length > 0 && (p.title || p.h1))
    .filter((p) => !ours.some((v) => v.length === p.embedding.length && cosine(v, p.embedding) >= COVER_SIMILARITY))
    .sort((a, b) => a.url.localeCompare(b.url));

  // Agrupación voraz y estable: cada página va al primer grupo cuyo representante se le parece.
  const groups: { rep: CompetitorTopicPage; members: CompetitorTopicPage[] }[] = [];
  for (const p of uncovered) {
    const g = groups.find((x) => cosine(x.rep.embedding, p.embedding) >= TOPIC_SIMILARITY);
    if (g) g.members.push(p);
    else groups.push({ rep: p, members: [p] });
  }

  return groups
    .map((g) => ({ ...g, domains: [...new Set(g.members.map((m) => m.domain))].sort() }))
    .filter((g) => g.domains.length >= MIN_DOMAINS)
    .sort((a, b) => b.domains.length - a.domains.length || b.members.length - a.members.length || a.rep.url.localeCompare(b.rep.url))
    .slice(0, MAX_GAP_FINDINGS)
    .map((g) => {
      const label = (g.rep.h1 ?? g.rep.title ?? g.rep.path).slice(0, 80);
      return {
        source: "competitors" as const,
        findingType: "competitor-gap" as const,
        stableKeyInput: `competitor-gap:${g.rep.url}`,
        title: `Tema que tratan ${g.domains.length} competidores y nosotros no: «${label}»`,
        detail: {
          tainted: true,
          domains: g.domains,
          // Solo rutas y títulos cortos de muestra: es una pista, no contenido a copiar.
          examples: g.members.slice(0, 5).map((m) => ({ domain: m.domain, path: m.path, title: (m.h1 ?? m.title ?? "").slice(0, 80) })),
          note: "Datos de competidores: no se copia texto; cualquier propuesta parte de nuestros datos y producto.",
        },
        sourceRefId: g.rep.url,
      };
    });
}
