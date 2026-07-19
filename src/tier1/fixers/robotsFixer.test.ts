import { test } from "node:test";
import assert from "node:assert/strict";
import { getRobotsFixerContent } from "./robotsFixer";

const EXPECTED_CONTENT = `import { MetadataRoute } from "next";

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

test("getRobotsFixerContent returns the canonical template for robots-missing-sitemap-directive", () => {
  assert.equal(getRobotsFixerContent("robots-missing-sitemap-directive"), EXPECTED_CONTENT);
});

test("getRobotsFixerContent returns the canonical template for robots-blocks-all", () => {
  assert.equal(getRobotsFixerContent("robots-blocks-all"), EXPECTED_CONTENT);
});

test("getRobotsFixerContent returns null for a finding type with no fixer", () => {
  assert.equal(getRobotsFixerContent("sitemap-malformed"), null);
  assert.equal(getRobotsFixerContent("performance-low-score"), null);
});
