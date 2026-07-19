// src/tier1/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openPullRequestWithFileChange,
  getPullRequestStatus,
  mergePullRequest,
  getExistingFileSha,
  getFileContent,
} from "./github";

function fakeFetchSequence(responses: { url: RegExp; method: string; body: unknown }[]) {
  let call = 0;
  return async (url: string, init?: RequestInit) => {
    const step = responses[call];
    call += 1;
    if (!step) throw new Error(`Unexpected extra fetch call: ${init?.method} ${url}`);
    assert.match(url, step.url);
    assert.equal(init?.method, step.method);
    return {
      ok: true,
      json: async () => step.body,
    } as Response;
  };
}

test("openPullRequestWithFileChange performs the 4-call sequence: get main SHA, create branch, upsert file, open PR", async () => {
  const fetchImpl = fakeFetchSequence([
    { url: /git\/ref\/heads\/main$/, method: "GET", body: { object: { sha: "abc123" } } },
    { url: /git\/refs$/, method: "POST", body: { ref: "refs/heads/seo-agent/fix-robots" } },
    { url: /contents\/src%2Fapp%2Frobots\.ts$/, method: "PUT", body: { content: { sha: "def456" } } },
    { url: /\/pulls$/, method: "POST", body: { html_url: "https://github.com/dieg092/wedding-invite-2/pull/42", number: 42 } },
  ]);

  const result = await openPullRequestWithFileChange({
    filePath: "src/app/robots.ts",
    newContent: "export default function robots() {}\n",
    branchName: "seo-agent/fix-robots",
    commitMessage: "fix: restore correct robots.ts",
    prTitle: "[SEO Agent] Fix robots.ts",
    prBody: "Automated Tier 1 fix.",
    existingFileSha: "current-blob-sha",
    fetchImpl,
  });

  assert.equal(result.prUrl, "https://github.com/dieg092/wedding-invite-2/pull/42");
  assert.equal(result.prNumber, 42);
});

test("openPullRequestWithFileChange includes the existing file's blob sha in the PUT body when updating a file that already exists", async () => {
  let capturedPutBody: string | undefined;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") capturedPutBody = init.body as string;
    if (/git\/ref\/heads\/main$/.test(url)) {
      return { ok: true, json: async () => ({ object: { sha: "abc123" } }) } as Response;
    }
    if (/git\/refs$/.test(url)) {
      return { ok: true, json: async () => ({ ref: "refs/heads/x" }) } as Response;
    }
    if (init?.method === "PUT") {
      return { ok: true, json: async () => ({ content: { sha: "def456" } }) } as Response;
    }
    return { ok: true, json: async () => ({ html_url: "https://github.com/dieg092/wedding-invite-2/pull/1", number: 1 }) } as Response;
  };

  await openPullRequestWithFileChange({
    filePath: "src/app/robots.ts",
    newContent: "content",
    branchName: "seo-agent/fix-robots",
    commitMessage: "fix",
    prTitle: "[SEO Agent] Fix",
    prBody: "body",
    existingFileSha: "current-blob-sha",
    fetchImpl,
  });

  assert.ok(capturedPutBody);
  const parsedBody = JSON.parse(capturedPutBody!);
  assert.equal(parsedBody.sha, "current-blob-sha");
});

test("openPullRequestWithFileChange throws when GitHub returns a non-ok response (e.g. 403 on PR creation)", async () => {
  let call = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    call += 1;
    if (call === 1) {
      assert.match(url, /git\/ref\/heads\/main$/);
      return { ok: true, json: async () => ({ object: { sha: "abc123" } }) } as Response;
    }
    if (call === 2) {
      assert.match(url, /git\/refs$/);
      return { ok: true, json: async () => ({ ref: "refs/heads/seo-agent/fix-robots" }) } as Response;
    }
    if (call === 3) {
      assert.equal(init?.method, "PUT");
      return { ok: true, json: async () => ({ content: { sha: "def456" } }) } as Response;
    }
    // 4th call: POST /pulls fails with a 403, as happened in production when the
    // token initially lacked Pull requests permission.
    assert.match(url, /\/pulls$/);
    return {
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ message: "Resource not accessible by personal access token" }),
    } as Response;
  };

  await assert.rejects(
    () =>
      openPullRequestWithFileChange({
        filePath: "src/app/robots.ts",
        newContent: "export default function robots() {}\n",
        branchName: "seo-agent/fix-robots",
        commitMessage: "fix: restore correct robots.ts",
        prTitle: "[SEO Agent] Fix robots.ts",
        prBody: "Automated Tier 1 fix.",
        existingFileSha: "current-blob-sha",
        fetchImpl,
      }),
    /GitHub API request failed: 403/,
  );
});

test("getPullRequestStatus maps GitHub's merged/state fields to open/merged/closed", async () => {
  const merged = await getPullRequestStatus({
    prNumber: 42,
    fetchImpl: async () => ({ ok: true, json: async () => ({ state: "closed", merged: true }) }) as Response,
  });
  assert.equal(merged, "merged");

  const closed = await getPullRequestStatus({
    prNumber: 43,
    fetchImpl: async () => ({ ok: true, json: async () => ({ state: "closed", merged: false }) }) as Response,
  });
  assert.equal(closed, "closed");

  const open = await getPullRequestStatus({
    prNumber: 44,
    fetchImpl: async () => ({ ok: true, json: async () => ({ state: "open", merged: false }) }) as Response,
  });
  assert.equal(open, "open");
});

test("mergePullRequest calls the GitHub merge endpoint with PUT", async () => {
  let capturedUrl: string | undefined;
  let capturedMethod: string | undefined;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedMethod = init?.method;
    return { ok: true, json: async () => ({ merged: true }) } as Response;
  };

  await mergePullRequest({ prNumber: 42, fetchImpl });

  assert.match(capturedUrl!, /\/pulls\/42\/merge$/);
  assert.equal(capturedMethod, "PUT");
});

test("mergePullRequest throws on a non-ok response, matching the established pattern", async () => {
  const fetchImpl = async () =>
    ({ ok: false, status: 405, statusText: "Method Not Allowed" }) as Response;

  await assert.rejects(
    () => mergePullRequest({ prNumber: 42, fetchImpl }),
    /GitHub API request failed: 405/,
  );
});

test("getExistingFileSha fetches the sha field from the GitHub contents API", async () => {
  let capturedUrl: string | undefined;
  const fetchImpl = async (url: string) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ sha: "abc123", content: "" }) } as Response;
  };

  const sha = await getExistingFileSha({ filePath: "src/app/robots.ts", fetchImpl });

  assert.equal(sha, "abc123");
  assert.match(capturedUrl!, /\/contents\/src%2Fapp%2Frobots\.ts$/);
});

test("getFileContent fetches and base64-decodes the content field from the GitHub contents API", async () => {
  const encoded = Buffer.from("export default {}", "utf8").toString("base64");
  const fetchImpl = async () =>
    ({ ok: true, json: async () => ({ sha: "abc123", content: encoded }) }) as Response;

  const content = await getFileContent({ filePath: "src/app/robots.ts", fetchImpl });

  assert.equal(content, "export default {}");
});

test("getExistingFileSha throws on a non-ok response, matching the established pattern", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, statusText: "Not Found" }) as Response;

  await assert.rejects(
    () => getExistingFileSha({ filePath: "src/app/robots.ts", fetchImpl }),
    /GitHub API request failed: 404/
  );
});
