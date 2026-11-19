// src/editorial/claims.ts
// Cifras nuevas sin fuente (riesgo 5): una mejora de artículo no puede inventarse datos. Toda cifra
// (porcentaje, euros, «N de cada M») que no estaba en la versión de main tiene que ir en un párrafo
// con un enlace a su fuente. Es determinista: no depende del juicio del evaluador.

const FIGURE = /\b\d+(?:[.,]\d+)*\s?(?:%|por ciento|€|euros?)|€\s?\d+(?:[.,]\d+)*|\b\d+\s+de\s+cada\s+\d+\b/gi;
const LINK = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|<a\s[^>]*href=["']https?:\/\//i;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/euros?/g, "€").replace(/por ciento/g, "%").replace(/\s/g, "");

export function figures(text: string): string[] {
  return (text.match(FIGURE) ?? []).map(norm);
}

export interface UnsourcedFigure {
  figure: string;
  paragraph: string;
}

/** Cifras de la rama que no estaban en main y cuyo párrafo no enlaza ninguna fuente externa. */
export function unsourcedNewFigures(baseText: string, headText: string): UnsourcedFigure[] {
  const known = new Set(figures(baseText));
  const out: UnsourcedFigure[] = [];
  for (const paragraph of headText.split(/\n\s*\n/)) {
    const fresh = figures(paragraph).filter((f) => !known.has(f));
    if (fresh.length === 0) continue;
    if (LINK.test(paragraph)) continue;
    for (const f of fresh) out.push({ figure: f, paragraph: paragraph.trim().slice(0, 160) });
  }
  return out;
}
