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
4. **Un único PR por sesión, no uno por enlace** (corregido 2026-07-29:
   la primera pasada de este flujo abrió 29 PRs, cada merge disparó un
   deploy de producción en Vercel y encoló decenas de builds — no vuelvas
   a hacer eso). Antes de tocar GitHub, aplica en local/memoria todas las
   ediciones que vayas aprobando para cada artículo origen. Cuando tengas
   el lote completo de la sesión decidido (todas las oportunidades ya
   evaluadas, aplicadas o rechazadas), usa el cliente de GitHub construido
   en la Fase 3 (`src/tier1/github.ts`) para escribir **una sola rama**
   contra `wedding-invite-2`:
   - Crea la rama una vez a partir de `main` (`git/refs`).
   - Para cada artículo con al menos un enlace aprobado, sube su
     contenido final (con todos sus enlaces nuevos ya insertados) a esa
     misma rama con una llamada a `contents` por archivo — no crees una
     rama nueva ni un PR por cada enlace individual, ni siquiera uno por
     artículo. `openPullRequestWithFileChange` crea rama + PR en la misma
     llamada, así que para esto solo reutiliza la parte de `contents`
     (o añade una función de commit-a-rama-existente si hace falta) y
     deja la apertura de PR para el final.
   - El archivo a modificar es el contenido del artículo origen —
     confirma primero la ruta exacta (los artículos viven en
     `src/lib/blog/content/<categoría>/<slug>.ts` en `wedding-invite-2`,
     contienen el markdown embebido).
5. Abre **un único PR** al final, con todos los artículos modificados de
   la sesión, y mergéalo tú mismo inmediatamente (usando
   `mergePullRequest` de `src/tier1/github.ts`) — no lo dejes esperando
   revisión. La decisión editorial (paso 3) ya es el filtro humano; una
   vez tomada para todo el lote, aplicar el cambio de inmediato es lo que
   se pide explícitamente al lanzar esta revisión (revisado 2026-07-20,
   ya no depende de si `internal-link-suggestion` está graduado — se
   aplica siempre). Lo que cambia el 2026-07-29 es solo la agrupación en
   un PR/merge por sesión en vez de por enlace — un solo deploy de
   Vercel por sesión, no uno por cada enlace añadido.
6. Registra cada enlace aplicado como un `AppliedChange` propio con
   `status: "merged"` y `findingType: "internal-link-suggestion"`, aunque
   varios compartan el mismo `prUrl`/`prNumber` del PR único del paso 5 —
   la granularidad de `AppliedChange` sigue siendo una por oportunidad,
   solo el PR que las agrupa es compartido. Guarda también `filePath` (la
   ruta exacta del archivo) y `previousContent` (el contenido completo
   del artículo ANTES de tu edición, tal cual lo leíste, no el contenido
   ya con otros enlaces de la misma sesión aplicados) — esto es lo que
   permite abrir un PR de reversión automático si más adelante
   `measure-applied-changes` detecta que el enlace tuvo impacto negativo
   (Fase 6). Este mecanismo de medición y reversión sigue funcionando
   igual — lo único que cambia es que el PR que referencia puede contener
   también otros enlaces, no que dejes de vigilar el impacto después.
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
- Nunca abras ni mergees un PR por cada enlace. Cada merge a `main` en
  `wedding-invite-2` dispara un deploy de producción en Vercel; abrir y
  mergear PR a PR en una sesión con muchas oportunidades encola un deploy
  por cada uno. Acumula todos los enlaces aprobados de la sesión y ciérralo
  con un único PR/merge al final (ver paso 4-5).

## Cadencia

Semanal (recomendado) + bajo demanda. No hay automatización que te
recuerde hacerlo — es una tarea que tú decides lanzar, coherente con que
el razonamiento con IA en este proyecto depende deliberadamente de esta
máquina y tu sesión de Claude Code, no de un cron desatendido.
