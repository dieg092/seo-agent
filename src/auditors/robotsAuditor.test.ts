import { test } from "node:test";
import assert from "node:assert/strict";
import { auditRobots } from "./robotsAuditor";

test("auditRobots passes when the sitemap is referenced and /admin is disallowed", async () => {
  const result = await auditRobots({
    fetchText: async () => "User-agent: *\nDisallow: /admin/\nSitemap: https://miwebdeboda.com/sitemap.xml\n",
    baseUrl: "https://miwebdeboda.com",
  });

  assert.equal(result.isValid, true);
  assert.deepEqual(result.errors, []);
});

test("auditRobots fails when the sitemap directive is missing", async () => {
  const result = await auditRobots({
    fetchText: async () => "User-agent: *\nDisallow: /admin/\n",
    baseUrl: "https://miwebdeboda.com",
  });

  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.toLowerCase().includes("sitemap")));
});

test("auditRobots fails when the whole site is disallowed", async () => {
  const result = await auditRobots({
    fetchText: async () => "User-agent: *\nDisallow: /\nSitemap: https://miwebdeboda.com/sitemap.xml\n",
    baseUrl: "https://miwebdeboda.com",
  });

  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.includes("Disallow: /")));
});
