-- Permisos de tabla de seo_ci. Ejecutar como seo_agent_role (dueño de las tablas).
REVOKE ALL ON ALL TABLES IN SCHEMA seo_agent FROM seo_ci;
GRANT SELECT ON seo_agent."SeoControl" TO seo_ci;
GRANT SELECT, INSERT, UPDATE ON seo_agent."DeployEvent" TO seo_ci;
GRANT INSERT ON seo_agent."Alert" TO seo_ci;
