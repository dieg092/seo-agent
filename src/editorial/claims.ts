// src/editorial/claims.ts
// Cifras nuevas (riesgo 5): una mejora de artículo no puede inventarse datos. Toda cifra
// (porcentaje, euros, «N de cada M», plazos) que no estuviera ya en main bloquea, salvo que esté
// en el catálogo de evidencia admitida (evidence.ts) y el párrafo hable de lo mismo y la cite
// como toca. Un enlace cualquiera no basta: tiene que ser el de la fuente del dato. Es determinista.

/** Cambia si cambian las reglas de cifras: invalida la batería y la caché de la guarda. */
export const CLAIMS_VERSION = "claims-v3";

const NUM_WORD = "(?:un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|mil)";
const FIGURE = new RegExp(
  [
    String.raw`\b\d+(?:[.,]\d+)*\s?(?:%|por\s?ciento|€|euros?)`,
    String.raw`€\s?\d+(?:[.,]\d+)*`,
    String.raw`\b(?:\d+|${NUM_WORD})\s+de\s+cada\s+(?:\d+|${NUM_WORD})\b`,
    String.raw`\b${NUM_WORD}\s+por\s?ciento\b`,
    String.raw`\b(?:la mitad|un tercio|un cuarto|dos tercios|tres cuartos)\s+de\s+(?:las|los)\b`,
    String.raw`\b\d+(?:[.,]\d+)?\s?(?:-|a)?\s?\d*\s+(?:días|semanas|meses|años)\b`,
  ].join("|"),
  "gi",
);

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/euros?/g, "€")
    .replace(/por\s?ciento/g, "%")
    .replace(/\s/g, "");

export function figures(text: string): string[] {
  return (text.match(FIGURE) ?? []).map(norm);
}

export interface UnsourcedFigure {
  figure: string;
  paragraph: string;
}

/** Cifras de la rama que no estaban en main y que no justifica ningún dato admitido. */
export function unsourcedNewFigures(baseText: string, headText: string, admitted: (paragraph: string, figure: string) => boolean = () => false): UnsourcedFigure[] {
  const known = new Set(figures(baseText));
  const out: UnsourcedFigure[] = [];
  for (const paragraph of headText.split(/\n\s*\n/)) {
    for (const f of figures(paragraph).filter((x) => !known.has(x) && !admitted(paragraph, x))) out.push({ figure: f, paragraph: paragraph.trim().slice(0, 160) });
  }
  return out;
}
