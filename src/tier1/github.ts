// src/tier1/github.ts
import { getEnv } from "../env";

function apiBase(): string {
  const owner = getEnv("GITHUB_REPO_OWNER");
  const repo = getEnv("GITHUB_REPO_NAME");
  return `https://api.github.com/repos/${owner}/${repo}`;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getEnv("WEDDING_INVITE_2_PAT")}`,
    "X-GitHub-Api-Version": "2022-11-28",
    Accept: "application/vnd.github+json",
  };
}

export async function openPullRequestWithFileChange(deps: {
  filePath: string;
  newContent: string;
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  existingFileSha?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ prUrl: string; prNumber: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = apiBase();
  const headers = authHeaders();

  const mainRefResponse = await fetchImpl(`${base}/git/ref/heads/main`, {
    method: "GET",
    headers,
  });
  const mainRef = (await mainRefResponse.json()) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  await fetchImpl(`${base}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${deps.branchName}`, sha: mainSha }),
  });

  const encodedPath = encodeURIComponent(deps.filePath).replace(/%2F/g, "%2F");
  const contentBase64 = Buffer.from(deps.newContent, "utf8").toString("base64");
  await fetchImpl(`${base}/contents/${encodedPath}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: deps.commitMessage,
      content: contentBase64,
      branch: deps.branchName,
      ...(deps.existingFileSha ? { sha: deps.existingFileSha } : {}),
    }),
  });

  const prResponse = await fetchImpl(`${base}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: deps.prTitle,
      body: deps.prBody,
      head: deps.branchName,
      base: "main",
    }),
  });
  const pr = (await prResponse.json()) as { html_url: string; number: number };

  return { prUrl: pr.html_url, prNumber: pr.number };
}

export async function getPullRequestStatus(deps: {
  prNumber: number;
  fetchImpl?: typeof fetch;
}): Promise<"open" | "merged" | "closed"> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = apiBase();
  const headers = authHeaders();

  const response = await fetchImpl(`${base}/pulls/${deps.prNumber}`, {
    method: "GET",
    headers,
  });
  const pr = (await response.json()) as { state: "open" | "closed"; merged: boolean };

  if (pr.state === "open") return "open";
  return pr.merged ? "merged" : "closed";
}
