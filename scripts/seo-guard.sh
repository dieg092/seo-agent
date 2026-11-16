#!/bin/bash
# Entrada de la guarda SEO para el worker de Órbita (COPY_WORKER_GUARD_CMD).
# Sin las URLs de BD del entorno del worker: seo-agent usa las de su .env.
unset DATABASE_URL DIRECT_URL BLOG_PHOTOS_DATABASE_URL APP_FUNNEL_DATABASE_URL
cd "$(dirname "$0")/.." || exit 75
exec ./node_modules/.bin/tsx scripts/seo-guard-check.ts "$@"
