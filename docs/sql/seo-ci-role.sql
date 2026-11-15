-- Rol seo_ci (B9): lo usa el despliegue de producción (miwebdeboda-deploy) para
-- seo-brake-gate y record-deploy. Solo puede leer SeoControl y DeployEvent,
-- registrar despliegues y dejar una alerta si para uno. Nada más.
-- La contraseña llega como variable de psql (-v ci_password=...) y no se guarda.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'seo_ci') THEN
    CREATE ROLE seo_ci LOGIN;
  END IF;
END $$;
ALTER ROLE seo_ci WITH LOGIN NOINHERIT CONNECTION LIMIT 3 PASSWORD :'ci_password';
ALTER ROLE seo_ci SET statement_timeout = '30s';
REVOKE ALL ON ALL TABLES IN SCHEMA seo_agent FROM seo_ci;
SELECT format('GRANT CONNECT ON DATABASE %I TO seo_ci', current_database()) \gexec
GRANT USAGE ON SCHEMA seo_agent TO seo_ci;
GRANT SELECT ON seo_agent."SeoControl" TO seo_ci;
GRANT SELECT, INSERT, UPDATE ON seo_agent."DeployEvent" TO seo_ci;
GRANT INSERT ON seo_agent."Alert" TO seo_ci;
-- Deshacer: DROP OWNED BY seo_ci; DROP ROLE seo_ci;
