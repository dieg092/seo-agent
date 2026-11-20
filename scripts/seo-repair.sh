#!/bin/zsh
# Lanzador del supervisor de autorreparación (LaunchAgent com.miwebdeboda.seo-repair).
# Nunca hereda URLs de BD de la shell: seo-agent carga las suyas de su .env.
unset DATABASE_URL DIRECT_URL BLOG_PHOTOS_DATABASE_URL APP_FUNNEL_DATABASE_URL
cd "$(dirname "$0")/.." || exit 1
exec ./node_modules/.bin/tsx scripts/seo-repair.ts "$@"
