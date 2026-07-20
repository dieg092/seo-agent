# SEO Agent — Revisión Tier 2 (Opus)

Instrucciones para cuando revises el briefing semanal de oportunidades
Tier 2 (`tier2-briefing.md`, generado por `pnpm generate:tier2-briefing`
o descargado como artifact del workflow `weekly-embeddings-and-briefing`).

## Qué hacer

1. Cubre el **100% de las oportunidades abiertas** de este tipo en la
   ejecución, no una muestra. Antes de empezar, cuenta cuántas hay
   (`prisma.opportunity.count({ where: { status: "open", source:
   "internalLinking" } })` o el número que muestra la tarjeta del panel) y
   ve tachándolas mentalmente conforme avances. Si el volumen es grande
   para una sola sesión, sigue en tandas hasta llegar a todas — no pares a
   medias sin decirlo. Cada oportunidad debe terminar en uno de tres
   estados, nunca en "no la miré": aplicada (pasos 4-7), rechazada por
   falta de frase natural (se queda abierta, ver paso 3), o descartada por
   el tope de enlaces por artículo (paso 2) — pero incluso en ese caso hay
   que haberla leído y comparado con las demás candidatas del mismo
   artículo origen antes de descartarla, no saltarla sin mirar.
2. Para no sobre-enlazar un mismo artículo, aplica como máximo 2-3 enlaces
   salientes nuevos por artículo origen en una misma pasada, priorizando
   las candidatas con mejor encaje editorial (no solo mayor similitud). Si
   un artículo origen tiene más candidatas de las que vas a aplicar,
   decide explícitamente cuáles son las mejores 2-3 tras leer todas sus
   opciones — no cojas las primeras por orden de aparición en el
   briefing.
3. Para cada sugerencia de enlazado interno (`internal-link-suggestion`):
   - Lee el texto de ambos artículos (ya incluido en el briefing).
   - Decide si el enlace tiene sentido editorial real — no te fíes solo
     de la puntuación de similitud, esa parte ya la hizo el pipeline
     determinista; tu criterio aquí es si un lector real se beneficiaría
     del enlace en ese contexto concreto.
   - Si decides que sí: elige la frase exacta del artículo origen donde
     insertar el enlace, y el texto ancla exacto a usar. No inventes
     contenido nuevo — el enlace debe encajar en una frase ya existente
     o una variación mínima de ella.
   - Si decides que no: marca la `Opportunity` con `reviewedNoActionAt:
     new Date()`, `reviewedNoActionContentHash` (el `contentHash` ACTUAL
     del artículo origen en `ArticleEmbedding`, para el `slug` de
     `detail.sourceSlug`) y `reviewedNoActionReason` (una frase con el
     motivo concreto: sin frase natural, mención genérica, redundante con
     un enlace ya existente, o descartada por el tope tras comparar con
     mejores candidatas). No cambies `status`, sigue `open`. Esto es
     importante: sin el hash, el briefing y la tarjeta del panel te
     volverán a enseñar la misma sugerencia que ya rechazaste como si
     fuera nueva, indistinguible de una que nunca has mirado — que es
     exactamente la confusión que este campo existe para evitar.
     `generateBriefing.ts` omite automáticamente cualquier oportunidad
     cuyo `reviewedNoActionContentHash` coincida con el `contentHash`
     actual del artículo; solo vuelve a aparecer si el artículo cambia de
     verdad (nuevo `contentHash`), momento en el que la revisión anterior
     ya no aplica y hay que evaluarla de nuevo con el mismo criterio.
4. Para cada enlace que decidas proponer, usa el cliente de GitHub ya
   construido en la Fase 3 (`src/tier1/github.ts`, función
   `openPullRequestWithFileChange`) para abrir un PR contra
   `wedding-invite-2`. El archivo a modificar es el contenido del
   artículo origen — confirma primero la ruta exacta del archivo (los
   artículos viven en `src/lib/blog/content/<categoría>/<slug>.ts` en el
   repo `wedding-invite-2`, contienen el markdown embebido).
5. Mergea el PR tú mismo inmediatamente tras abrirlo (usando
   `mergePullRequest` de `src/tier1/github.ts`) — no lo dejes esperando
   revisión. La decisión editorial (paso 3) ya es el filtro humano; una
   vez tomada, aplicar el cambio de inmediato es lo que se pide
   explícitamente al lanzar esta revisión (revisado 2026-07-20, ya no
   depende de si `internal-link-suggestion` está graduado — se aplica
   siempre, para cualquier PR que abras en este flujo).
6. Registra el PR (ya mergeado) como un `AppliedChange` con `status:
   "merged"` y `findingType: "internal-link-suggestion"`. Guarda también
   `filePath` (la ruta exacta del archivo que confirmaste en el paso 4) y
   `previousContent` (el contenido completo del artículo ANTES de tu
   edición, tal cual lo leíste) — esto es lo que permite abrir un PR de
   reversión automático si más adelante `measure-applied-changes`
   detecta que el enlace tuvo impacto negativo (Fase 6). Este mecanismo
   de medición y reversión sigue funcionando exactamente igual que antes
   — lo único que cambia es que ya no esperas una revisión previa al
   merge, no que dejes de vigilar el impacto después.
7. Marca la `Opportunity` correspondiente como `status: "resolved"` (con
   `resolvedAt: new Date()`) inmediatamente después de crear el
   `AppliedChange`. Esto es específico de `internal-link-suggestion`: a
   diferencia de los hallazgos de auditoría (robots, sitemap...), el
   detector de enlazado interno (`computeLinkSuggestions.ts`) no
   comprueba si el enlace ya existe en el contenido, así que la
   oportunidad NUNCA se marcaría como resuelta sola en una ejecución
   futura de `prioritize` — seguiría apareciendo en el briefing y en la
   tarjeta "Trabajos sugeridos" del panel como si nada se hubiera hecho.
   Si decides NO aplicar una sugerencia (paso 3), no la dejes intacta:
   registra el rechazo con los campos `reviewedNoAction*` como se explica
   ahí, para que no vuelva a contarse como "pendiente" hasta que el
   artículo cambie de verdad.

## Qué NO hacer

- Nunca generes contenido nuevo para justificar un enlace — si no hay una
  frase natural donde insertarlo, no lo propongas.
- Nunca toques las oportunidades Tier 3 (cannibalización, declive, gaps de
  contenido) — esas alimentan tu calendario editorial manual, no generan
  PRs ni aquí ni en ningún otro sitio del SEO Agent. Para esas, analiza y
  recomienda, pero no apliques ningún cambio de código sin que se te pida
  explícitamente.

## Cadencia

Semanal (recomendado) + bajo demanda. No hay automatización que te
recuerde hacerlo — es una tarea que tú decides lanzar, coherente con que
el razonamiento con IA en este proyecto depende deliberadamente de esta
máquina y tu sesión de Claude Code, no de un cron desatendido.
