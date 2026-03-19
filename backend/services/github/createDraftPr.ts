import { TEST_REPO_CONFIG } from "../../../config/repo";

type CreateDraftPrInput = {
  branchName: string;
  title: string;
  body: string;
};

export type DraftPrResult = {
  prNumber: number;
  prUrl: string;
  prTitle: string;
  status: "created" | "existing";
};

type GitHubPull = {
  number: number;
  title: string;
  html_url: string;
};

export function parseGitHubRepo(repoUrl: string) {
  const trimmedUrl = repoUrl.trim().replace(/\.git$/, "");
  const match = trimmedUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);

  if (!match) {
    throw new Error("TEST_REPO_URL must be a GitHub https URL");
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

export async function githubRequest(path: string, init: RequestInit = {}) {
  const githubToken = process.env.GITHUB_TOKEN?.trim() ?? "";

  if (!githubToken) {
    throw new Error("GITHUB_TOKEN is not configured");
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });

  return response;
}

async function findExistingPullRequest(owner: string, repo: string, branchName: string) {
  const head = `${owner}:${branchName}`;
  const response = await githubRequest(
    `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(head)}&state=all`,
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub PR lookup failed: ${response.status} ${message}`);
  }

  const pulls = (await response.json()) as GitHubPull[];
  return pulls[0] ?? null;
}

export async function updateDraftPr(input: { prNumber: number; title: string; body: string }) {
  const { owner, repo } = parseGitHubRepo(TEST_REPO_CONFIG.repoUrl);
  const response = await githubRequest(`/repos/${owner}/${repo}/pulls/${input.prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({
      title: input.title,
      body: input.body,
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub PR update failed: ${response.status} ${message}`);
  }

  const pull = (await response.json()) as GitHubPull;
  return {
    prNumber: pull.number,
    prUrl: pull.html_url,
    prTitle: pull.title,
  };
}

export async function createDraftPr(input: CreateDraftPrInput): Promise<DraftPrResult> {
  const { owner, repo } = parseGitHubRepo(TEST_REPO_CONFIG.repoUrl);
  const createResponse = await githubRequest(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      head: input.branchName,
      base: TEST_REPO_CONFIG.defaultBranch,
      body: input.body,
      draft: true,
    }),
  });

  if (createResponse.ok) {
    const pull = (await createResponse.json()) as GitHubPull;
    return {
      prNumber: pull.number,
      prUrl: pull.html_url,
      prTitle: pull.title,
      status: "created",
    };
  }

  if (createResponse.status === 422) {
    const existingPull = await findExistingPullRequest(owner, repo, input.branchName);

    if (existingPull) {
      return {
        prNumber: existingPull.number,
        prUrl: existingPull.html_url,
        prTitle: existingPull.title,
        status: "existing",
      };
    }
  }

  const message = await createResponse.text();
  throw new Error(`GitHub PR creation failed: ${createResponse.status} ${message}`);
}
