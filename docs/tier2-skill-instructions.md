# SEO Agent — Revisión Tier 2 (Opus)

Instrucciones para cuando revises el briefing semanal de oportunidades
Tier 2 (`tier2-briefing.md`, generado por `pnpm generate:tier2-briefing`
o descargado como artifact del workflow `weekly-embeddings-and-briefing`).

## Qué hacer

1. Lee `tier2-briefing.md` completo.
2. Para cada sugerencia de enlazado interno (`internal-link-suggestion`):
   - Lee el texto de ambos artículos (ya incluido en el briefing).
   - Decide si el enlace tiene sentido editorial real — no te fíes solo
     de la puntuación de similitud, esa parte ya la hizo el pipeline
     determinista; tu criterio aquí es si un lector real se beneficiaría
     del enlace en ese contexto concreto.
   - Si decides que sí: elige la frase exacta del artículo origen donde
     insertar el enlace, y el texto ancla exacto a usar. No inventes
     contenido nuevo — el enlace debe encajar en una frase ya existente
     o una variación mínima de ella.
   - Si decides que no: no hagas nada con esa sugerencia (no hace falta
     "rechazarla" explícitamente — si el pipeline determinista la sigue
     detectando la próxima semana, simplemente evalúala de nuevo con el
     mismo criterio).
3. Para cada enlace que decidas proponer, usa el cliente de GitHub ya
   construido en la Fase 3 (`src/tier1/github.ts`, función
   `openPullRequestWithFileChange`) para abrir un PR contra
   `wedding-invite-2`. El archivo a modificar es el contenido del
   artículo origen — confirma primero la ruta exacta del archivo (los
   artículos viven en `src/lib/blog/content/<categoría>/<slug>.ts` en el
   repo `wedding-invite-2`, contienen el markdown embebido).
4. Registra cada PR abierto como un `AppliedChange` (mismo modelo que
   Fase 3), con `findingType: "internal-link-suggestion"`.

## Graduación automática

Antes de abrir un PR de enlazado interno, comprueba si
`internal-link-suggestion` ya está graduado (consulta
`GraduationRecord` donde `findingType = "internal-link-suggestion"` y
`autoMergeEligible = true`). Si lo está, mergea el PR tú mismo
inmediatamente tras abrirlo (usando `mergePullRequest` de
`src/tier1/github.ts`) y marca el `AppliedChange` correspondiente como
`"merged"`. Si no está graduado (el caso normal al principio), deja el
PR abierto para que el humano lo revise, como hasta ahora.

## Qué NO hacer

- Nunca mergees el PR tú mismo salvo que `internal-link-suggestion`
  esté graduado (ver "Graduación automática" arriba) — en el caso
  normal, el humano decide, como en toda la Fase 3.
- Nunca generes contenido nuevo para justificar un enlace — si no hay una
  frase natural donde insertarlo, no lo propongas.
- Nunca toques las oportunidades Tier 3 (cannibalización, declive, gaps de
  contenido) — esas alimentan tu calendario editorial manual, no generan
  PRs ni aquí ni en ningún otro sitio del SEO Agent.

## Cadencia

Semanal (recomendado) + bajo demanda. No hay automatización que te
recuerde hacerlo — es una tarea que tú decides lanzar, coherente con que
el razonamiento con IA en este proyecto depende deliberadamente de esta
máquina y tu sesión de Claude Code, no de un cron desatendido.
