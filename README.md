# SEO Agent

Sistema de automatización SEO para miwebdeboda.com. Recolecta datos reales
(Search Console, Analytics, PageSpeed, auditorías propias), detecta
oportunidades, las prioriza, y aplica los cambios más simples solo —
siempre por PR, nunca sin que puedas revisarlo, salvo que una categoría
concreta se haya "graduado" (ver más abajo).

## Cadencia

| Job | Frecuencia | Qué hace |
|---|---|---|
| `daily-collection` | Diaria | Recolecta GSC (básico y completo), GA4 (totales y por landing), inspección de URLs y sitemaps de GSC; audita sitemap/robots/structured-data y producción; prioriza, aplica Tier 1 |
| `weekly-sync` | Semanal (lunes) | Sincroniza estado de PRs abiertos, mide impacto de cambios mergeados hace 2+ semanas |
| `weekly-embeddings-and-briefing` | Semanal (lunes) | Recalcula embeddings de artículos, sugerencias de enlazado interno, genera el briefing para tu revisión Tier 2 |
| `monthly-site-architecture` | Mensual (día 1) | Detecta problemas a nivel de plantilla: rendimiento agregado, contenido casi duplicado, huecos de páginas provinciales |

### Pasos de `daily-collection`

Todos los pasos de recogida y auditoría llevan `continue-on-error`: si uno
falla, los demás siguen, y `report-workflow-health` marca el run como
fallido y registra una alerta. En GitHub el job puede salir en verde aunque
un paso haya fallado; mira la alerta o el aviso de Telegram.

| Paso | Script | Guarda en |
|---|---|---|
| `collect-gsc` | `collect:search-console` | `SearchConsoleSnapshot` (colector original, sin cambios) |
| `collect-gsc-full` | `collect:search-console-full` | `SearchConsolePageDaily`, `SearchConsoleQueryTyped`, `SearchConsoleSegmentDaily`, `GscDataQuality` |
| `collect-ga4` | `collect:analytics` | `AnalyticsSnapshot` y `AnalyticsLandingDaily` |
| `collect-url-inspection` | `collect:url-inspection` | `UrlInspection` (por prioridad a diario, barrido de todo el sitemap los domingos) y `GscSitemapStatus` |
| `audit-sitemap`, `audit-robots`, `audit-structured-data` | `audit:*` | sus tablas `*AuditResult` |
| `audit-production` | `audit:production` | `ProductionProbeResult` y `PrivateIncident` |
| `audit-performance` | `audit:performance` | `PerformanceAuditResult` (solo lunes o lanzado a mano) |

### URLs privadas

Las webs de boda son privadas. Ninguna tabla guarda su URL en claro: se
guardan como `https://miwebdeboda.com/<privada:{hmac12}>` y, solo en
`PrivateIncident`, cifradas. Para eso los pasos nuevos necesitan el secret
`SEO_PRIVATE_URL_KEY`; sin él fallan sin escribir nada. La sonda de
producción abre además las muestras de `PRIVATE_PROBE_URLS` (variable del
repo) para comprobar que siguen con `noindex`. Si alguna aparece en el
sitemap, en GSC o sin `noindex`, queda abierta como incidente en
`PrivateIncident`.

## Los 3 Tiers

- **Tier 1**: determinista, sin ambigüedad (hoy: `robots.ts`). Abre PR
  solo. Nunca lo mergea, salvo que esté graduado.
- **Tier 2**: necesita juicio editorial (enlazado interno). Tú revisas el
  briefing semanal (`tier2-briefing.md`) y decides qué enlaces proponer —
  ver `docs/tier2-skill-instructions.md`.
- **Tier 3**: siempre humano (cannibalización, declive, gaps de contenido,
  Arquitectura del Sitio). Alimenta tu calendario editorial manual, nunca
  genera PRs.

## Qué es "graduación"

Cada tipo de hallazgo (`findingType`) empieza necesitando que tú mergees
cada PR a mano. Si acumula 10 instancias consecutivas mergeadas sin caída
de tráfico (medido 2 semanas antes/después de cada merge), pasa a
auto-mergearse sin esperar tu revisión. Un solo caso con caída de tráfico
≥15% revoca esa confianza de inmediato — vuelve a necesitar 10 instancias
limpias desde cero.

Si un cambio YA auto-mergeado resulta tener impacto negativo, el sistema
**nunca lo revierte solo** — abre un PR de reversión (si capturó el
contenido previo al aplicar el cambio) y registra una alerta. Revisa ese
PR y decide si mergearlo.

## Alertas

No se envían por email — se guardan en la tabla `Alert` y se muestran en
el panel de admin (`/admin/super/seo-agent`), arriba del todo, mientras
queden sin marcar como leídas. Tipos: impacto negativo detectado,
graduación conseguida, graduación revocada, PR de reversión abierto (o
reversión manual necesaria si no se pudo abrir uno), PAT de GitHub
caducando en menos de 30 días.

## Qué mirar y con qué frecuencia

- **Semanalmente**: el panel de admin (`/admin/super/seo-agent` en
  `wedding-invite-2`) — alertas sin leer primero, luego oportunidades
  abiertas, estado de graduación por tipo de hallazgo, últimos 20 cambios
  aplicados. Si hay sugerencias de enlazado interno pendientes, lanza una
  sesión de Claude Code y sigue `docs/tier2-skill-instructions.md`.
- **Cuando el panel muestre una alerta sin leer**: siempre indica qué
  pasó y qué hacer (PR de reversión ya abierto → revísalo y decide;
  graduación conseguida/revocada → informativo; PAT caducando → genera
  uno nuevo antes de la fecha indicada). Márcala como leída una vez
  atendida.
- **Mensualmente**: revisa los hallazgos de Arquitectura del Sitio en el
  panel (Tier 3 — decisiones tuyas, no generan PRs).

## Variables de entorno

Ver `.env.example` para la lista completa y de dónde sale cada valor. En
GitHub Actions, los valores secretos van como *secrets* del repo
(`DATABASE_URL`, `DIRECT_URL`, credenciales de Google, `PAGESPEED_API_KEY`,
`WEDDING_INVITE_2_PAT`, `SEO_PRIVATE_URL_KEY`, Telegram) y los no secretos
como *variables* (`GSC_SITE_URL`, `GA4_PROPERTY_ID`, `SITE_BASE_URL`,
`TARGET_REPO_OWNER`, `TARGET_REPO_NAME`, `PRIVATE_PROBE_URLS`).

## Tests

Se ejecutan contra un Postgres local, nunca contra Neon:

```bash
pnpm test:db:setup   # crea/actualiza la BD local seo_agent_test
pnpm test            # SEO_ENV=test, no lee .env
```
