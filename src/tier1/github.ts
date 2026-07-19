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

  const mainRefUrl = `${base}/git/ref/heads/main`;
  const mainRefResponse = await fetchImpl(mainRefUrl, {
    method: "GET",
    headers,
  });
  if (!mainRefResponse.ok) {
    throw new Error(
      `GitHub API request failed: ${mainRefResponse.status} ${mainRefResponse.statusText} (${mainRefUrl})`,
    );
  }
  const mainRef = (await mainRefResponse.json()) as { object: { sha: string } };
  const mainSha = mainRef.object.sha;

  const createRefUrl = `${base}/git/refs`;
  const createRefResponse = await fetchImpl(createRefUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${deps.branchName}`, sha: mainSha }),
  });
  if (!createRefResponse.ok) {
    throw new Error(
      `GitHub API request failed: ${createRefResponse.status} ${createRefResponse.statusText} (${createRefUrl})`,
    );
  }

  const encodedPath = encodeURIComponent(deps.filePath).replace(/%2F/g, "%2F");
  const contentBase64 = Buffer.from(deps.newContent, "utf8").toString("base64");
  const contentsUrl = `${base}/contents/${encodedPath}`;
  const contentsResponse = await fetchImpl(contentsUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: deps.commitMessage,
      content: contentBase64,
      branch: deps.branchName,
      ...(deps.existingFileSha ? { sha: deps.existingFileSha } : {}),
    }),
  });
  if (!contentsResponse.ok) {
    throw new Error(
      `GitHub API request failed: ${contentsResponse.status} ${contentsResponse.statusText} (${contentsUrl})`,
    );
  }

  const pullsUrl = `${base}/pulls`;
  const prResponse = await fetchImpl(pullsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: deps.prTitle,
      body: deps.prBody,
      head: deps.branchName,
      base: "main",
    }),
  });
  if (!prResponse.ok) {
    throw new Error(
      `GitHub API request failed: ${prResponse.status} ${prResponse.statusText} (${pullsUrl})`,
    );
  }
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

  const pullUrl = `${base}/pulls/${deps.prNumber}`;
  const response = await fetchImpl(pullUrl, {
    method: "GET",
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} (${pullUrl})`);
  }
  const pr = (await response.json()) as { state: "open" | "closed"; merged: boolean };

  if (pr.state === "open") return "open";
  return pr.merged ? "merged" : "closed";
}

export async function mergePullRequest(deps: {
  prNumber: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = apiBase();
  const headers = authHeaders();

  const mergeUrl = `${base}/pulls/${deps.prNumber}/merge`;
  const response = await fetchImpl(mergeUrl, {
    method: "PUT",
    headers,
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} (${mergeUrl})`);
  }
}

async function fetchContentsApi(deps: {
  filePath: string;
  fetchImpl?: typeof fetch;
}): Promise<{ sha: string; content: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = apiBase();
  const headers = authHeaders();

  const url = `${base}/contents/${encodeURIComponent(deps.filePath)}`;
  const response = await fetchImpl(url, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText} (${url})`);
  }
  return (await response.json()) as { sha: string; content: string };
}

export async function getExistingFileSha(deps: {
  filePath: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const data = await fetchContentsApi(deps);
  return data.sha;
}

export async function getFileContent(deps: {
  filePath: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const data = await fetchContentsApi(deps);
  return Buffer.from(data.content, "base64").toString("utf8");
}
