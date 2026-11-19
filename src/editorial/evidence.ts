// src/editorial/evidence.ts
// Evidencia admitida: el catálogo de cifras que una mejora de artículo SÍ puede usar. Una cifra
// nueva (que no estaba en main) pasa la guarda solo si está en el catálogo, el párrafo habla de
// lo mismo (palabras de contexto) y la cita como toca (enlace a la fuente o nombre de la fuente).
// Todo lo demás sigue bloqueado. Cuatro fuentes, de más a menos propia:
//   - propio: datos agregados de las bodas reales de la app (vista seo_wedding_facts, ≥ 30 bodas);
//   - banco: filas «Verificado» del banco de datos del blog (src/lib/blog/facts-bank.md de main);
//   - web: frases con cifra de las páginas de datos de la propia web (/estadisticas-bodas…);
//   - producto: precios fijos del producto (solo la Básica, 49 €; los premium cambian por temporada).
// Es determinista: no llama al modelo. Si el catálogo no se ha podido refrescar en 14 días, caduca
// y la guarda vuelve a no admitir ninguna cifra nueva (lo seguro).
import { createHash } from "node:crypto";
import { figures } from "./claims";

export type FactKind = "propio" | "banco" | "web" | "producto";

export interface Fact {
  key: string;
  kind: FactKind;
  /** Cifras aceptadas, normalizadas como `figures()`. */
  forms: string[];
  /** Lo que dice el dato, para el prompt y para el revisor. */
  statement: string;
  /** Raíces sin tildes que tienen que salir en el párrafo (al menos `contextMin`). */
  context: string[];
  contextMin: number;
  /** Enlaces que valen como cita: rutas de la web (/estadisticas-bodas/espana) o dominios (ine.es). */
  cite: string[];
  /** Nombres que valen como cita si no hay enlace (INE, Bodas.net, miwebdeboda). */
  names: string[];
  sourceName: string;
  sourceUrl: string | null;
  sampleSize: number | null;
}

export const EVIDENCE_MAX_AGE_DAYS = 14;
export const EVIDENCE_REFRESH_HOURS = 24;
export const MIN_WEDDINGS = 30;

const STOP = new Set(
  "sobre entre desde hasta donde cuando porque aunque tambien todas todos todo toda otras otros otra otro estas estos esta este para segun como mismo misma cada solo pero muchos muchas mucho mucha tiene tienen suele suelen puede pueden hacer mas menos alrededor media medio total datos fuente verificado cifra cifras parejas boda bodas españa"
    .split(" "),
);

export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Palabras con contenido (≥ 5 letras, sin tildes, sin las vacías), como raíz de 6 letras. */
export function contentWords(text: string, limit = 12): string[] {
  const out: string[] = [];
  for (const w of fold(text).split(/[^a-zñ]+/)) {
    if (w.length < 5 || STOP.has(w)) continue;
    const stem = w.slice(0, 6);
    if (!out.includes(stem)) out.push(stem);
    if (out.length >= limit) break;
  }
  return out;
}

const keyOf = (f: Omit<Fact, "key">) => createHash("sha256").update(JSON.stringify([f.kind, f.forms, f.statement, f.cite])).digest("hex").slice(0, 24);
const withKey = (f: Omit<Fact, "key">): Fact => ({ ...f, key: keyOf(f) });

/** Enlaces de un párrafo en markdown o sueltos: rutas y dominios, sin «www.». */
function linksOf(paragraph: string): string[] {
  const out: string[] = [];
  for (const m of paragraph.matchAll(/\]\(([^)\s]+)\)|(https?:\/\/[^\s)>\]]+)/g)) {
    const raw = m[1] ?? m[2];
    try {
      const u = new URL(raw, "https://miwebdeboda.com");
      const host = u.hostname.replace(/^www\./, "");
      out.push(host === "miwebdeboda.com" ? u.pathname.replace(/\/+$/, "") || "/" : host);
    } catch {
      // enlace roto: no cuenta como cita
    }
  }
  return out;
}

function cites(paragraph: string, f: Fact): boolean {
  const links = linksOf(paragraph);
  if (links.some((l) => f.cite.some((c) => (c.startsWith("/") ? l === c : l === c || l.endsWith(`.${c}`))))) return true;
  const p = fold(paragraph);
  return f.names.some((n) => new RegExp(`(^|[^a-z0-9])${fold(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(p));
}

/** El dato del catálogo que justifica esta cifra en este párrafo, o null. */
export function admittingFact(paragraph: string, figure: string, facts: readonly Fact[]): Fact | null {
  for (const f of facts) {
    if (!f.forms.includes(figure)) continue;
    if (contextHits(paragraph, f) < Math.min(f.contextMin, f.context.length)) continue;
    if (cites(paragraph, f)) return f;
  }
  return null;
}

/** Huella del catálogo (entra en la caché de la guarda: si cambia, se vuelve a decidir). */
export function factsHash(facts: readonly Fact[]): string {
  return createHash("sha256").update(facts.map((f) => f.key).sort().join(",")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- propio (vista de la app)

export interface WeddingFactRow {
  metric: string;
  value: number;
  unit: string;
  n_bodas: number;
  n_registros: number;
  desde: Date | string | null;
  hasta: Date | string | null;
}

const DIETS: Record<string, string> = { ninguna: "no pide ninguna dieta especial", "sin-gluten": "pide menú sin gluten", vegetariana: "pide menú vegetariano", vegana: "pide menú vegano", diabetica: "pide menú para diabéticos", "baja-en-sal": "pide menú bajo en sal", halal: "pide menú halal", kosher: "pide menú kosher" };
const ALLERGENS: Record<string, string> = { altramuces: "altramuces", apio: "apio", cacahuetes: "cacahuetes", crustaceos: "crustáceos", "frutos-cascara": "frutos de cáscara", gluten: "gluten", huevos: "huevo", lactosa: "lactosa o lácteos", moluscos: "moluscos", mostaza: "mostaza", pescado: "pescado", sesamo: "sésamo", soja: "soja", sulfitos: "sulfitos" };
const DRINKS: Record<string, string> = { agua: "agua", "cafe-te": "café o té", espumoso: "cava o champán", cerveza: "cerveza", "coctel-gin": "cóctel de gin", "coctel-ron": "cóctel de ron", "coctel-tequila": "cóctel de tequila", "coctel-vodka": "cóctel de vodka", "coctel-whisky": "cóctel de whisky", "coctel-sin-alcohol": "cóctel sin alcohol", licores: "licores digestivos", refrescos: "refrescos", vermut: "vermut", "vino-blanco": "vino blanco", "vino-tinto": "vino tinto", zumos: "zumos" };
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DAYS: Record<string, string> = { lunes: "lunes", martes: "martes", miercoles: "miércoles", jueves: "jueves", viernes: "viernes", sabado: "sábado", domingo: "domingo" };
const SECTIONS: Record<string, string> = { DIET_TYPE: "pregunta por la dieta de los invitados", FOOD_ALLERGIES: "pregunta por alergias", DRINK_PREFERENCES: "pregunta por las bebidas preferidas", BUS: "ofrece autobús", BUS_SELECTION: "deja elegir autobús al confirmar", GIFT_LIST: "pone lista de regalos o número de cuenta", MENUS: "enseña el menú", PHOTO_GALLERY: "tiene galería de fotos", GUESTS_AND_KIDS: "pregunta por niños", COMPANION: "pregunta por acompañante", LODGING: "recomienda alojamiento", PASSWORD_PROTECTION: "protege la web con contraseña", GUEST_LIST: "solo deja confirmar a quien está en la lista", AGENDA: "publica el horario del día", DRESS_CODE: "indica código de vestimenta", PRE_WEDDING_LOCATION: "tiene preboda", RESTAURANTS: "recomienda restaurantes", PRACTICAL_INFO: "da información práctica" };

/** Frase, contexto obligatorio y formas aceptadas de cada métrica conocida (las desconocidas no entran). */
function describe(metric: string, v: number): { what: string; context: string[] } | null {
  const [head, arg] = metric.split(":");
  const pct = `el ${String(v).replace(".", ",")} %`;
  switch (head) {
    case "invitados_asisten_mediana": return { what: `la mediana de invitados que asisten es de ${Math.round(v)} personas`, context: ["invitad"] };
    case "invitados_asisten_p25": return { what: `una de cada cuatro bodas tiene ${Math.round(v)} asistentes o menos`, context: ["invitad"] };
    case "invitados_asisten_p75": return { what: `una de cada cuatro bodas supera los ${Math.round(v)} asistentes`, context: ["invitad"] };
    case "respuestas_no_asisten_pct": return { what: `${pct} de las respuestas son «no podré asistir»`, context: ["asist"] };
    case "respuestas_no_asisten_mediana_boda_pct": return { what: `en la boda típica (mediana), ${pct} de quienes responden no puede asistir`, context: ["asist"] };
    case "acompanante_pct": return { what: `${pct} de los invitados que asisten viene con acompañante (en las bodas que lo preguntan)`, context: ["acompa"] };
    case "ninos_pct": return { what: `${pct} de los invitados que asisten viene con niños (en las bodas que lo preguntan)`, context: ["nino"] };
    case "preboda_asisten_pct": return { what: `${pct} de los invitados que asisten a la boda va también a la preboda`, context: ["prebod"] };
    case "dieta": return DIETS[arg] ? { what: `${pct} de los invitados que asisten ${DIETS[arg]} (en las bodas que preguntan por la dieta)`, context: [arg === "ninguna" ? "dieta" : contentWords(DIETS[arg].replace(/pide menú( para)?/, ""))[0] ?? "dieta"] } : null;
    case "alergia_alguna_pct": return { what: `${pct} de los invitados que asisten declara alguna alergia o intolerancia`, context: ["alergi"] };
    case "alergia": return ALLERGENS[arg] ? { what: `${pct} de los invitados que asisten declara alergia o intolerancia a ${ALLERGENS[arg]}`, context: ["alergi", contentWords(ALLERGENS[arg], 1)[0] ?? fold(ALLERGENS[arg]).slice(0, 5)] } : null;
    case "bebida": return DRINKS[arg] ? { what: `${pct} de los invitados que indican sus bebidas elige ${DRINKS[arg]}`, context: [fold(DRINKS[arg]).split(" ").find((w) => w.length >= 4)?.slice(0, 6) ?? "bebida"] } : null;
    case "transporte_autobus_pct": return { what: `${pct} de los invitados que asisten elige ir en el autobús (en las bodas que lo ofrecen)`, context: ["autobu"] };
    case "limite_antes_boda_dias_mediana": return { what: `la fecha límite para confirmar se pone, en mediana, ${Math.round(v)} días antes de la boda`, context: ["limite"] };
    case "publicada_antes_boda_dias_mediana": return { what: `la web de boda se publica, en mediana, ${Math.round(v)} días antes de la boda`, context: ["public"] };
    case "respuestas_ultima_semana_antes_limite_pct": return { what: `${pct} de las respuestas llega en la última semana antes de la fecha límite`, context: ["limite"] };
    case "respuestas_tras_limite_pct": return { what: `${pct} de las respuestas llega después de la fecha límite`, context: ["limite"] };
    case "respuestas_ultimo_mes_pct": return { what: `${pct} de las respuestas llega en el último mes antes de la boda`, context: ["respue|confir"] };
    case "respuestas_antes_boda_dias_mediana": return { what: `la respuesta típica (mediana) llega ${Math.round(v)} días antes de la boda`, context: ["respue|confir"] };
    case "recordatorio_responden_pct": return { what: `${pct} de las invitaciones que reciben un recordatorio responde después de él`, context: ["record"] };
    case "mes": { const m = MONTHS[Number(arg) - 1]; return m ? { what: `${pct} de las bodas se celebra en ${m}`, context: [m.slice(0, 6)] } : null; }
    case "dia": return DAYS[arg] ? { what: `${pct} de las bodas se celebra en ${DAYS[arg]}`, context: [arg.slice(0, 6)] } : null;
    case "seccion": return SECTIONS[arg] ? { what: `${pct} de las webs de boda ${SECTIONS[arg]}`, context: contentWords(SECTIONS[arg], 1) } : null;
    default: return null;
  }
}

const NUM_WORDS = ["cero", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez"];

/** Formas en que se puede escribir la cifra (entero, con decimal, «N de cada 10», «la mitad», semanas). */
function formsOf(value: number, unit: string): string[] {
  const raw: string[] = [];
  if (unit === "%") {
    raw.push(`${Math.round(value)} %`);
    if (!Number.isInteger(value)) raw.push(`${String(value).replace(".", ",")} %`, `${value} %`);
    const n = Math.round(value / 10);
    if (n >= 1 && n <= 9 && Math.abs(value - n * 10) <= 1) raw.push(`${n} de cada 10`, `${NUM_WORDS[n]} de cada diez`, ...(n === 1 ? ["uno de cada diez"] : []));
    if (Math.abs(value - 50) <= 2) raw.push("la mitad de los", "la mitad de las");
  } else if (unit === "días") {
    const d = Math.round(value);
    raw.push(`${d} días`);
    if (d % 7 === 0) raw.push(`${d / 7} semanas`);
  }
  return [...new Set(raw.flatMap((r) => figures(r)))];
}

const isoDay = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "?");

export function factsFromWeddingRows(rows: readonly WeddingFactRow[]): Fact[] {
  const out: Fact[] = [];
  for (const r of rows) {
    if (r.n_bodas < MIN_WEDDINGS || !Number.isFinite(Number(r.value))) continue;
    const v = Number(r.value);
    const d = describe(r.metric, v);
    if (!d) continue;
    out.push(
      withKey({
        kind: "propio",
        forms: formsOf(v, r.unit),
        statement: `Datos de miwebdeboda (${r.n_bodas} bodas celebradas entre ${isoDay(r.desde)} y ${isoDay(r.hasta)}): ${d.what}.`,
        context: d.context,
        contextMin: d.context.length,
        cite: [],
        names: ["miwebdeboda", "con nosotros", "nuestras bodas", "nuestros datos"],
        sourceName: "Datos agregados de las bodas de miwebdeboda",
        sourceUrl: null,
        sampleSize: r.n_bodas,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- banco (facts-bank.md)

const DOMAIN = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:es|com|net|org|eu|mx|co|ar|cl|pe|gob\.es|com\.mx))\b/gi;

// Fuentes genéricas («Sector eventos España», «Foros…»): no son un nombre que se pueda citar.
const GENERIC_LEAD = /^(sector|mercado|foros?|comunidad|testimonio|varias|media|fuentes?|estimaci|guia|blog)\b/i;
/** «Mesalia Catering» también se cita como «Mesalia» (la primera palabra, si es una marca). */
const brandOf = (lead: string) => {
  const first = lead.split(/\s+/)[0];
  return lead.includes(" ") && /^[A-ZÁÉÍÓÚ][a-záéíóúñ]{4,}$/.test(first) ? [first] : [];
};

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Filas verificadas del banco de datos del blog. Las que dicen «NO usar», ❌ o ⚠ no entran. */
export function factsFromBank(md: string): Fact[] {
  const out: Fact[] = [];
  let header: string[] | null = null;
  for (const line of md.split("\n")) {
    if (!line.trim().startsWith("|")) {
      header = null;
      continue;
    }
    const cells = cellsOf(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    if (!header) {
      header = cells.map(fold);
      continue;
    }
    // Hay celdas con «|» dentro de una cita: las columnas se cuentan desde el final (fuente, verificado, usos).
    const at = (name: string) => header!.findIndex((h) => h.startsWith(name));
    const iVer = at("verificado");
    const iSrc = at("fuente");
    if (iVer < 0 || iSrc < 0 || iSrc > iVer) continue;
    const offVer = header.length - iVer;
    if (cells.length < header.length) continue;
    const verified = cells[cells.length - offVer] ?? "";
    if (!/^verificado/i.test(verified)) continue;
    const row = cells.join(" | ");
    if (/no usar|❌|⚠|pendiente verificar|no verificad/i.test(row)) continue;
    // Las citas con «|» suelen estar en la columna de la fuente: el dato son las columnas de antes de ella.
    const claim = cells.slice(0, iSrc).join(" — ");
    const forms = [...new Set(figures(claim))];
    if (!forms.length) continue;
    const src = cells.slice(iSrc, cells.length - offVer).join(" ");
    const hosts = [...new Set([...src.matchAll(DOMAIN)].map((m) => m[1].toLowerCase().replace(/^www\./, "")))];
    // Nombres que valen como cita: los dominios, las siglas oficiales y el nombre con que empieza la fuente.
    const lead = src.split(/\s[—–-]\s|[(,;:«"“]/)[0].replace(/\*/g, "").trim();
    const names = [
      ...hosts,
      ...(src.match(/\b(?:INE|INEGI|DANE|INDEC|BOE|OCU|Eurostat)\b/g) ?? []),
      ...(lead && lead.split(/\s+/).length <= 4 && /[A-ZÁÉÍÓÚ]/.test(lead) && lead.length >= 3 && !GENERIC_LEAD.test(lead) ? [lead, ...brandOf(lead)] : []),
    ];
    out.push(
      withKey({
        kind: "banco",
        forms,
        statement: `${claim.replace(/\s+/g, " ").slice(0, 400)} (fuente: ${src.replace(/\s+/g, " ").slice(0, 200)})`,
        context: contentWords(cells[0], 10),
        contextMin: 2,
        cite: hosts,
        names: [...new Set(names)],
        sourceName: src.slice(0, 120),
        sourceUrl: hosts[0] ? `https://${hosts[0]}` : null,
        sampleSize: null,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- web (páginas de datos propias)

/** Frases con cifra de una página de datos de la web: se citan enlazando la página o su fuente. */
export function factsFromPage(path: string, text: string, sourceHosts: readonly string[]): Fact[] {
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    const forms = [...new Set(figures(s))];
    if (!forms.length || s.length > 400 || seen.has(s)) continue;
    seen.add(s);
    // Solo frases que nombran a un organismo oficial de estadística: las demás cifras de la página
    // pueden ser estimaciones sin fuente y no se propagan a otros artículos.
    const acronyms = [...new Set(s.match(/\b(?:INE|INEGI|DANE|INDEC|INEC|INEI|ISTAT|ONS|Eurostat|Registro Civil)\b/g) ?? [])];
    if (!acronyms.length) continue;
    out.push(
      withKey({
        kind: "web",
        forms,
        statement: `${s} (publicado en miwebdeboda.com${path})`,
        context: contentWords(s, 10),
        contextMin: 2,
        cite: [path, ...sourceHosts],
        names: acronyms,
        sourceName: `miwebdeboda.com${path}`,
        sourceUrl: `https://miwebdeboda.com${path}`,
        sampleSize: null,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- producto

export function productFacts(): Fact[] {
  return [
    withKey({
      kind: "producto",
      forms: figures("49 €"),
      statement: "El Premium básico de miwebdeboda cuesta 49 € (precio fijo, pago único). Los otros planes cambian por temporada: no se citan.",
      context: ["premiu|basic|plan"],
      contextMin: 1,
      cite: ["/precios"],
      names: ["miwebdeboda"],
      sourceName: "Precios de miwebdeboda",
      sourceUrl: "https://miwebdeboda.com/precios",
      sampleSize: null,
    }),
  ];
}

// El contexto puede llevar alternativas «a|b»: basta con una.
const altHit = (p: string, c: string) => c.split("|").some((x) => p.includes(x));
export function contextHits(paragraph: string, f: Fact): number {
  const p = fold(paragraph);
  return f.context.filter((c) => altHit(p, c)).length;
}

/** Los datos más relevantes para un artículo (por palabras compartidas), para el prompt de la IA. */
export function factsForPrompt(topic: string, facts: readonly Fact[], limit = 40): Fact[] {
  const words = new Set(contentWords(topic, 60));
  const score = (f: Fact) => f.context.filter((c) => c.split("|").some((x) => [...words].some((w) => w.startsWith(x) || x.startsWith(w)))).length + (f.kind === "propio" ? 0.5 : 0);
  return [...facts].sort((a, b) => score(b) - score(a)).slice(0, limit);
}

/** Bloque de texto para el prompt: cómo usar cada dato y cómo citarlo. */
export function renderFactsForPrompt(facts: readonly Fact[]): string {
  if (!facts.length) return "";
  const how = (f: Fact) =>
    f.kind === "propio"
      ? "atribúyelo a miwebdeboda («en las bodas que se organizan con miwebdeboda…»)"
      : f.cite.length
        ? `enlaza ${f.cite.map((c) => (c.startsWith("/") ? c : `https://${c}`)).slice(0, 2).join(" o ")}${f.names.length ? ` o nombra ${f.names.slice(0, 2).join(" / ")}` : ""}`
        : `nombra ${f.names.slice(0, 2).join(" / ")}`;
  return [
    "Datos admitidos: son las ÚNICAS cifras nuevas (porcentajes, euros, «N de cada M», plazos) que puedes añadir. Úsalas solo si vienen al caso, en el mismo párrafo cítalas como se indica y no cambies su valor ni su sentido. Cualquier otra cifra nueva bloquea el cambio.",
    ...facts.map((f) => `- ${f.statement} → ${how(f)}.`),
  ].join("\n");
}
