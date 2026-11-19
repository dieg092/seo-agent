// src/editorial/fixtures/validationCases.ts
// Batería de defectos (plan de Codex, paso 4). Todo es sintético: un artículo base razonable
// y 20 «mejoras» que parecen aportar algo pero esconden un defecto conocido. La guarda editorial
// completa (pairedDecision) no puede aprobar ninguna crítica y como mucho puede dejar pasar el 10 %
// del resto. Casos críticos: cifras inventadas, contradicciones y cambio de intención.

export const BATTERY_VERSION = "battery-v2";
export const BATTERY_SLUG = "bateria/lista-de-invitados";

export const BASE_ARTICLE = `# Cómo hacer la lista de invitados de la boda sin discutir

Hacer la lista de invitados es lo primero que conviene cerrar, porque de ella dependen el sitio, el menú y el presupuesto. Aquí tenéis un método que funciona para parejas que no quieren pasarse semanas negociando. Sale de lo que vemos en las parejas que organizan su boda con nosotros: las que fijan el límite antes de apuntar nombres discuten menos y recortan menos al final.

![Pareja repasando la lista de invitados en una mesa con una libreta](/images/blog/lista-invitados.webp)

## Empezad por el límite, no por los nombres

Antes de apuntar a nadie, decidid cuántas personas caben en el sitio que os gusta y cuántas podéis pagar (si aún no tenéis la cifra, empezad por [cómo calcular el presupuesto de la boda](/blog/organizar-boda/presupuesto-boda)). El número más bajo de los dos es vuestro límite real. Si empezáis por los nombres, la lista crece sin freno y luego toca recortar a gente que ya sabía que estaba invitada.

## Repartid por círculos

Haced tres columnas:

| Círculo | Quién entra |
|---|---|
| Imprescindibles | Familia directa y amigos íntimos |
| Importantes | Familia extensa y amigos con trato frecuente |
| Opcionales | Compañeros de trabajo, conocidos y acompañantes |

Rellenad primero los imprescindibles de los dos lados. Si ya llegáis al límite, los opcionales no entran y os ahorráis la discusión.

## Acordad las reglas antes de discutir casos

Poned por escrito tres o cuatro reglas que valgan para los dos: por ejemplo, que no se invita por compromiso a quien no veis desde hace años, o que los acompañantes solo entran si tienen pareja estable. Cuando surja un caso dudoso, aplicad la regla y no la opinión del momento.

## Pedid la confirmación por escrito

Las confirmaciones de palabra se olvidan. Pedid que cada invitado confirme por escrito, con un formulario o un mensaje, e indicad una fecha límite clara. Si tenéis [web de boda con confirmación de asistencia](/web-de-boda), las respuestas quedan apuntadas solas y no tenéis que perseguir a nadie. Así sabréis el número final a tiempo para cerrarlo con el catering.

## Qué hacer con los padres

Si los padres pagan una parte, es razonable que propongan algunos nombres, pero dentro del límite que habéis fijado. Dadles un número de plazas concreto en vez de discutir nombre por nombre.
`;

export interface BatteryCase {
  id: string;
  kind: "figures" | "contradiction" | "intent" | "omission" | "misleading-link" | "filler" | "generic" | "redundancy";
  critical: boolean;
  head: string;
}

const add = (section: string) => `${BASE_ARTICLE}\n${section.trim()}\n`;
const replace = (from: string, to: string) => {
  if (!BASE_ARTICLE.includes(from)) throw new Error(`caso de batería mal construido: ${from.slice(0, 30)}`);
  return BASE_ARTICLE.replace(from, to);
};

export const BATTERY_CASES: BatteryCase[] = [
  // ── Cifras inventadas (críticos) ───────────────────────────────────────────
  { id: "cifra-porcentaje", kind: "figures", critical: true, head: add(`## Lo que hacen otras parejas\n\nSegún nuestra experiencia, el 68% de las parejas recorta la lista al menos dos veces. Tenerlo en cuenta desde el principio os ahorra disgustos y os ayuda a fijar el límite con realismo.`) },
  { id: "cifra-precio", kind: "figures", critical: true, head: add(`## Cuánto cuesta cada invitado\n\nEl cubierto medio en España ronda los 95 € por invitado, así que cada persona que añadís a la lista pesa en el presupuesto. Hacer la cuenta antes de invitar ayuda a ser coherentes.`) },
  { id: "cifra-proporcion", kind: "figures", critical: true, head: add(`## Cuántos dirán que sí\n\nNo todos los invitados vienen: siete de cada diez suelen confirmar, así que podéis invitar a algo más de gente de la que cabe sin miedo a pasaros.`) },
  { id: "cifra-plazo", kind: "figures", critical: true, head: replace("e indicad una fecha límite clara.", "e indicad una fecha límite clara: lo correcto es enviarlas 6 semanas antes y cerrar la lista 15 días antes de la boda.") },
  // ── Contradicciones (críticos) ─────────────────────────────────────────────
  {
    id: "contradice-limite",
    kind: "contradiction",
    critical: true,
    head: add(`## Un truco que funciona\n\nEn realidad, lo mejor es empezar apuntando a todas las personas que queréis invitar, sin pensar en el sitio ni en el presupuesto. Cuando tengáis la lista completa, ya buscaréis un lugar donde quepan todos.`),
  },
  {
    id: "contradice-confirmacion",
    kind: "contradiction",
    critical: true,
    head: add(`## Confirmaciones sin complicaciones\n\nNo hace falta pedir confirmación por escrito ni poner fecha límite: la gente de confianza avisa de palabra y agobiar a los invitados con formularios queda frío. Con preguntar en persona es suficiente.`),
  },
  {
    id: "contradice-compromiso",
    kind: "contradiction",
    critical: true,
    head: add(`## Mejor que sobre a que falte\n\nAnte la duda, invitad también a quien no veis desde hace años: es preferible quedar bien con todo el mundo y luego ya veréis cómo encajáis el número.`),
  },
  // ── Cambio de intención (críticos) ─────────────────────────────────────────
  {
    id: "intencion-luna-de-miel",
    kind: "intent",
    critical: true,
    head: `# Cómo hacer la lista de invitados de la boda sin discutir\n\nLa lista de invitados importa, pero lo que de verdad recordaréis es el viaje. Por eso aquí os contamos cómo elegir destino de luna de miel.\n\n## Playa o ciudad\n\nSi os gusta descansar, buscad un destino de playa tranquilo; si preferís moveros, una ruta por varias ciudades. Pensad en la época del año y en cuánto queréis conducir.\n\n## Reservad con tiempo\n\nLos vuelos y los hoteles buenos se agotan, así que conviene reservar en cuanto tengáis la fecha. Comparad varias agencias antes de decidir.\n\n## Qué meter en la maleta\n\nLlevad ropa cómoda, un adaptador de enchufe y copias de los documentos.\n`,
  },
  {
    id: "intencion-venta",
    kind: "intent",
    critical: true,
    head: `# Cómo hacer la lista de invitados de la boda sin discutir\n\nOlvidaos de las hojas de cálculo y de las discusiones: con miwebdeboda lo tenéis todo resuelto. Nuestra web de boda es la forma más moderna de organizar vuestro gran día.\n\n## Por qué elegir miwebdeboda\n\nDiseños preciosos, fáciles de editar y pensados para vosotros. Vuestros invitados verán toda la información en un solo sitio.\n\n## Empezad hoy\n\nCread vuestra web en pocos minutos y compartidla con quien queráis. ¡No esperéis más para tener la boda que soñáis!\n`,
  },
  {
    id: "intencion-protocolo-mesas",
    kind: "intent",
    critical: true,
    head: replace(
      BASE_ARTICLE.slice(BASE_ARTICLE.indexOf("## Repartid por círculos"), BASE_ARTICLE.indexOf("## Pedid la confirmación")),
      `## Cómo colocar las mesas\n\nLa mesa presidencial va frente a la entrada y los novios en el centro. A los lados se sientan los padrinos y los padres. Las mesas de familia van cerca de la presidencial y las de amigos hacia el fondo, junto a la pista de baile.\n\n## La mesa de los niños\n\nSi hay muchos niños, ponedles una mesa propia con un monitor y un menú sencillo.\n\n`,
    ),
  },
  // ── Omisiones ─────────────────────────────────────────────────────────────
  {
    id: "omite-metodo",
    kind: "omission",
    critical: false,
    head: replace(
      BASE_ARTICLE.slice(BASE_ARTICLE.indexOf("## Empezad por el límite"), BASE_ARTICLE.indexOf("## Pedid la confirmación")),
      `## Un proceso muy personal\n\nCada pareja vive la lista de invitados a su manera y no hay una única forma correcta de hacerla. Lo importante es que os sintáis cómodos con el resultado y que disfrutéis del camino.\n\n## Escuchad a vuestro corazón\n\nAl final, las personas que deben estar son las que sentís cerca. Confiad en vuestra intuición.\n\n`,
    ),
  },
  {
    id: "omite-reglas",
    kind: "omission",
    critical: false,
    head: replace(
      BASE_ARTICLE.slice(BASE_ARTICLE.indexOf("## Acordad las reglas"), BASE_ARTICLE.indexOf("## Pedid la confirmación")),
      `## Hablad con calma\n\nCuando haya desacuerdos, respirad hondo y hablad con calma. La comunicación es la base de todo y os ayudará también en el matrimonio.\n\n`,
    ),
  },
  // ── Enlaces engañosos ─────────────────────────────────────────────────────
  {
    id: "enlace-engañoso-plantilla",
    kind: "misleading-link",
    critical: false,
    head: add(`## Plantilla gratuita\n\nDescargad nuestra [plantilla gratuita de lista de invitados en Excel](/precios) y rellenadla con los círculos que os hemos explicado. Es la forma más rápida de empezar.`),
  },
  {
    id: "enlace-engañoso-estudio",
    kind: "misleading-link",
    critical: false,
    head: add(`## Lo que dicen los expertos\n\nUn [estudio oficial sobre bodas en España](/blog) concluye que las listas por círculos reducen los conflictos familiares a la mitad. Por eso lo recomendamos.`),
  },
  // ── Relleno y fórmulas vacías ─────────────────────────────────────────────
  {
    id: "relleno-introduccion",
    kind: "filler",
    critical: false,
    head: replace(
      "Hacer la lista de invitados es lo primero que conviene cerrar,",
      "En el mundo actual, organizar una boda es una experiencia única e inolvidable. Sin lugar a dudas, cada detalle cuenta y es importante destacar que todo debe ser perfecto. Además, cabe mencionar que la lista de invitados es clave. Hacer la lista de invitados es lo primero que conviene cerrar,",
    ),
  },
  {
    id: "relleno-conclusion",
    kind: "filler",
    critical: false,
    head: add(`## Conclusión\n\nEn definitiva, hacer la lista de invitados es una experiencia única. Sin lugar a dudas, con estos consejos tendréis la boda perfecta. Es importante destacar que lo más importante es disfrutar. ¡No esperéis más y empezad hoy mismo a planificar el día más especial de vuestra vida!`),
  },
  {
    id: "relleno-consejos-vacios",
    kind: "filler",
    critical: false,
    head: add(`## Consejos clave\n\n- Planificad con tiempo.\n- Disfrutad del proceso.\n- Tened en cuenta todos los detalles.\n- La comunicación es clave.\n- La organización es clave.\n- Sed vosotros mismos.`),
  },
  // ── Genérico ──────────────────────────────────────────────────────────────
  {
    id: "generico-reescritura",
    kind: "generic",
    critical: false,
    head: `# Cómo hacer la lista de invitados de la boda sin discutir\n\nLa lista de invitados es un aspecto importante de cualquier boda. Hay que tener en cuenta muchos factores y pensar bien a quién invitar.\n\n## Pensad bien a quién invitar\n\nEs importante invitar a las personas importantes para vosotros. Pensad en la familia, en los amigos y en otras personas cercanas.\n\n## Tened en cuenta el espacio\n\nEl espacio es un factor a tener en cuenta. También el presupuesto es un factor a tener en cuenta.\n\n## Hablad entre vosotros\n\nHablar es importante para llegar a acuerdos. Escuchaos y buscad el equilibrio.\n\n## Confirmaciones\n\nLas confirmaciones son importantes para saber cuántos seréis.\n`,
  },
  {
    id: "generico-seccion",
    kind: "generic",
    critical: false,
    head: add(`## Otros aspectos a tener en cuenta\n\nAdemás de todo lo anterior, hay otros aspectos a tener en cuenta a la hora de hacer la lista. Cada boda es diferente y cada pareja tiene sus propias necesidades. Lo importante es tener en cuenta todos los aspectos y tomar las mejores decisiones para vosotros.`),
  },
  // ── Redundancia ───────────────────────────────────────────────────────────
  {
    id: "redundancia-repite",
    kind: "redundancy",
    critical: false,
    head: add(`## Resumen del método\n\nAntes de apuntar a nadie, decidid cuántas personas caben en el sitio que os gusta y cuántas podéis pagar. Haced tres columnas: imprescindibles, importantes y opcionales. Poned por escrito tres o cuatro reglas que valgan para los dos. Pedid que cada invitado confirme por escrito. Dadles a los padres un número de plazas concreto.\n\n## Recordad\n\nDecidid el límite antes que los nombres, repartid por círculos, acordad reglas, pedid confirmación por escrito y dad plazas a los padres.`),
  },
];

/** Para la batería: total ≥ 90 % y todos los críticos detectados. */
export const BATTERY_MIN_RATE = 0.9;
