# Ciclo de vida, prioridad y resultado de un hallazgo (fase 2c)

Implementa las secciones §6, §12.2, §12.3 y §15.2 de la especificación maestra.

| Pieza | Archivo | Qué hace |
|---|---|---|
| Máquina de estados | `src/opportunity/lifecycle.ts` | `transition(lifecycle, evento, ahora)`, función pura |
| Catálogo por tipo | `src/prioritization/catalog.ts` | severidad, confianza, autonomía, carril y operación de cada `findingType` |
| Prioridad | `src/prioritization/priority.ts` | `computePriority` devuelve la puntuación y todos sus factores |
| Carriles y cupos | `src/prioritization/lanes.ts` | `selectByLane` elige qué hallazgos pasan hoy a tarea |
| Resultado de un cambio | `src/graduation/computeOutcome.ts` | positive / negative / inconclusive / pending / not_evaluable |

## Decisiones tomadas donde la especificación no dice nada

Para cambiar cualquiera de ellas basta con tocar la constante o la tabla que se indica y su test.

- **`status` y `state` conviven.** `status` (open/resolved) sigue con la regla de siempre porque lo leen tier1, tier2 y el panel. `state` es el estado de §6. Cuando el puente de la fase 3 lea `state`, `status` se puede dejar de usar.
- **Salidas de `blocked`.** El diagrama no tiene ninguna: se añaden `task-started` (la tarea se desbloquea) y `task-cancelled` (`TASK_TRANSITIONS` en `lifecycle.ts`).
- **Cancelar la tarea** lleva a `dismissed` desde open, queued, in_progress y blocked (§7: «cancelled → dismissed»).
- **`detected` que desaparece** vuelve a 0 confirmaciones y sigue en `detected`. No pasa a `resolved` para que una reaparición tenga que confirmarse otra vez.
- **`open` → `resolved` sin cambio:** con 3 evaluaciones seguidas sin la condición (§6, «cuándo se resuelve»).
- **`stale` por tiempo:** `verifying` a los 60 días sin resolverse; `open`, solo si su tarea ya está cerrada (`tick` con `taskClosed`). Hasta que exista `SeoTaskLink` (fase 3), `prioritize` pasa `taskClosed: false`. `stale` es terminal.
- **Oscilaciones:** se cuentan las reaperturas desde la primera de la ventana; si la primera tiene más de 60 días, la cuenta vuelve a empezar.
- **Intención de la página** (`intentOfPage`): `product` = home, `/precios`, `/plantillas`, `/funcionalidades`, `/invitacion-digital-boda` y `/tool`; `professional` = `/profesionales` y `/colaboraciones`; `content` = blog, glosario, estadísticas, guía, calculadora y herramientas; el resto, `other`.
- **Tipos actuales que el Anexo B no nombra:** se asimilan al más parecido (`performance-*` = `perf-lab-poor`; `content-declining` = `visibility-declining`, A1 de investigación; `internal-link-suggestion` es heurístico y por tanto A2). El esfuerzo sale de `heuristics.ts`.
- **Prioridad sin embudo ni aprendizaje:** `FunnelOrganicDaily` no existe todavía y `learning` solo se activa con volumen (§15.2), así que `prioritize` pasa `funnel: null` y `learning: null`. La función ya los admite.
- **`computeOutcome`:** se mantiene el mínimo de 20 clics de base. En el modo `low` (el actual) solo hay veredicto con un cambio de más de ±50% y al menos 300 impresiones por ventana; en el modo `high`, diferencia en diferencias frente al control y banda de ruido. `measureImpact` usa el modo `low`, compara clics, toma el merge como despliegue (hasta que exista `DeployEvent`) y no guarda nada mientras el resultado sea `pending`.
