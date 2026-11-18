// src/editorial/hollow.ts
// Detector de fórmulas vacías (capa determinista, §16.4): lista versionada de muletillas
// (la misma base que ai-smell-checks de wedding-invite-2), conectores repetidos, n-gramas
// repetidos y frases demasiado iguales de largo. Es una señal de calidad, no de autoría.

export const HOLLOW_LIST_VERSION = "2026-11-18";

export const HOLLOW_PHRASES = [
  "optimiza tu experiencia",
  "plataforma revolucionaria",
  "solución innovadora",
  "eleva tu boda",
  "transforma tu evento",
  "plataforma todo en uno",
  "tecnología de vanguardia",
  "sumérgete",
  "descubre el secreto",
  "todo lo que necesitas saber",
  "en el mundo de",
  "en la era de",
  "no es solo",
  "más que un simple",
  "un sinfín de",
  "día tan especial",
  "el día más importante de tu vida",
];

export const CONNECTORS = [
  "además",
  "asimismo",
  "por otro lado",
  "en este sentido",
  "en definitiva",
  "en conclusión",
  "cabe destacar",
  "es importante destacar",
  "es fundamental",
  "es esencial",
  "conviene tener en cuenta",
  "hoy en día",
  "cada vez más",
  "sin duda",
  "la clave está en",
  "la buena noticia es que",
  "pero eso no es todo",
  "dicho esto",
  "en última instancia",
];

/** Por cada 1.000 palabras. */
export const CONNECTORS_PER_1000_MAX = 6;
export const REPEATED_NGRAM = 5;
export const REPEATED_NGRAM_MAX = 3;
/** Coeficiente de variación de la longitud de las frases: por debajo, todas iguales. */
export const SENTENCE_CV_MIN = 0.3;

export interface HollowSignal {
  check: string;
  detail: string;
}

export interface HollowResult {
  signals: HollowSignal[];
  /** Hay fórmulas vacías suficientes para topar naturalidad y genérico. */
  hollow: boolean;
  words: number;
}

const count = (text: string, needle: string) => {
  const re = new RegExp(`(?<![\\p{L}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "gu");
  return (text.match(re) ?? []).length;
};

export function detectHollow(text: string): HollowResult {
  const lower = text.toLowerCase();
  const words = lower.match(/\p{L}+/gu) ?? [];
  const signals: HollowSignal[] = [];

  const phrases = HOLLOW_PHRASES.filter((p) => count(lower, p) > 0);
  if (phrases.length) signals.push({ check: "muletillas", detail: phrases.join(", ") });

  const connectorHits = CONNECTORS.map((c) => [c, count(lower, c)] as const).filter(([, n]) => n > 0);
  const totalConnectors = connectorHits.reduce((s, [, n]) => s + n, 0);
  const per1000 = words.length ? (totalConnectors * 1000) / words.length : 0;
  if (words.length >= 200 && per1000 > CONNECTORS_PER_1000_MAX) {
    signals.push({ check: "conectores", detail: `${per1000.toFixed(1)} por 1.000 palabras (${connectorHits.map(([c, n]) => `${c} ×${n}`).join(", ")})` });
  }

  const grams = new Map<string, number>();
  for (let i = 0; i + REPEATED_NGRAM <= words.length; i++) {
    const g = words.slice(i, i + REPEATED_NGRAM).join(" ");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  const repeated = [...grams].filter(([, n]) => n >= REPEATED_NGRAM_MAX).sort((a, b) => b[1] - a[1]);
  if (repeated.length) signals.push({ check: "ngramas-repetidos", detail: repeated.slice(0, 5).map(([g, n]) => `«${g}» ×${n}`).join(", ") });

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => (s.match(/\p{L}+/gu) ?? []).length)
    .filter((n) => n >= 3);
  if (sentences.length >= 15) {
    const mean = sentences.reduce((s, n) => s + n, 0) / sentences.length;
    const sd = Math.sqrt(sentences.reduce((s, n) => s + (n - mean) ** 2, 0) / sentences.length);
    const cv = sd / mean;
    if (cv < SENTENCE_CV_MIN) signals.push({ check: "frases-iguales", detail: `variación de longitud ${cv.toFixed(2)} (< ${SENTENCE_CV_MIN})` });
  }

  return { signals, hollow: signals.length >= 2 || phrases.length >= 2, words: words.length };
}
