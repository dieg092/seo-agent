-- Rol seo_ci (B9): lo usa el despliegue de producción (miwebdeboda-deploy) para
-- seo-brake-gate y record-deploy. Solo puede leer SeoControl y DeployEvent,
-- registrar despliegues y dejar una alerta si para uno. Nada más.
-- La contraseña llega como variable de psql (-v ci_password=...) y no se guarda.
-- Base: proyecto Neon cold-term-21943279, rama seo-agent, BD wedding-invite.
-- Este fichero se ejecuta como wedding-invite_owner (crea el rol). Los GRANT de
-- tablas solo funcionan como su dueño, seo_agent_role: ejecuta seo-ci-grants.sql
-- con ese rol.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_ci') THEN
    CREATE ROLE seo_ci LOGIN;
  END IF;
END $$;
ALTER ROLE seo_ci WITH LOGIN NOINHERIT CONNECTION LIMIT 3 PASSWORD :'ci_password';
ALTER ROLE seo_ci SET statement_timeout = '30s';
SELECT format('GRANT CONNECT ON DATABASE %I TO seo_ci', current_database()) \gexec
GRANT USAGE ON SCHEMA seo_agent TO seo_ci;
-- Deshacer: DROP OWNED BY seo_ci; DROP ROLE seo_ci;
