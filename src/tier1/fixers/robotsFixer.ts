const CANONICAL_ROBOTS_TS = `import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin/",
          "/api/",
          "/login",
          "/forgot-password",
          "/reset-password",
          "/verify-email",
          "/email-preview/",
        ],
      },
    ],
    sitemap: [
      "https://miwebdeboda.com/sitemap.xml",
      "https://miwebdeboda.com/sitemap-images.xml",
    ],
  };
}
`;

const HANDLED_FINDING_TYPES = new Set([
  "robots-missing-sitemap-directive",
  "robots-blocks-all",
]);

export function getRobotsFixerContent(findingType: string): string | null {
  if (!HANDLED_FINDING_TYPES.has(findingType)) return null;
  return CANONICAL_ROBOTS_TS;
}
