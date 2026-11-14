# Puente con Órbita (fase 3: solo propuestas)

`scripts/seo-bridge.ts` (`pnpm seo:bridge`, `--dry-run` para simular). Lo lanza el LaunchAgent
`com.miwebdeboda.seo-bridge` cada 30 minutos (`launchd/`, registro en `~/Library/Logs/seo-bridge.log`).

En cada pasada:

1. **Reconciliación.** Lee cada tarea enlazada (`SeoTaskLink` abierto) con `orbita-task get --json`:
   empezada → `in_progress`; bloqueada → `blocked`; hecha → el hallazgo pasa a `verifying` (sin
   `DeployEvent` hasta la fase 4); cancelada o borrada → `dismissed`.
2. **Caducidad.** Una tarea que sigue en `todo` se cancela (`cancel --if-status todo`) si su hallazgo
   ya está resuelto o si pasó `expiresAt` (7 días las urgentes, 30 el resto). Las caducadas vuelven a
   `open` y se pueden proponer otra vez.
3. **Creación.** Hallazgos en `open` sin tarea, por prioridad, con los cupos por carril de
   `lanes.ts`, una tarea por página y operación, y `--dedupe-key` con el `stableKey`. El contrato
   (`src/bridge/contract.ts`) va en `tasks.metadata.seo` y citado en el prompt. Los de nivel 1
   (tier1) y las sugerencias de enlaces (tanda semanal de tier2) no pasan por aquí.
4. **Latido** en `WorkflowHeartbeat` (`seo-bridge`).

Todas las tareas de IA entran con «propuesta»: no se ejecuta nada hasta que el fundador la quita.
`publishPolicy` es `pr-only` o `none`; ninguna se fusiona sola hasta activar A1 en la fase 4.

Para apagarlo: `launchctl bootout gui/$(id -u)/com.miwebdeboda.seo-bridge`.
