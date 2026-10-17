import type { GithubIssue, GithubComment } from '../../src/frontend/types';

const GITHUB_API = 'https://api.github.com';

function makeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

export async function githubFetch(
  token: string,
  method: string,
  urlPath: string,
  body?: unknown
): Promise<unknown> {
  const opts: RequestInit = { method, headers: makeHeaders(token) };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(`${GITHUB_API}${urlPath}`, opts);
  if (res.status === 204) return null;

  const json = await res.json() as unknown;
  if (!res.ok) {
    const msg = (json as { message?: string })?.message ?? JSON.stringify(json);
    throw new Error(`GitHub ${method} ${urlPath} → ${res.status}: ${msg}`);
  }
  return json;
}

export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'all'
): Promise<GithubIssue[]> {
  const all: GithubIssue[] = [];
  let page = 1;
  while (true) {
    const batch = await githubFetch(
      token, 'GET',
      `/repos/${owner}/${repo}/issues?state=${state}&per_page=100&page=${page}`
    ) as GithubIssue[];

    const issues = batch.filter((i: GithubIssue) => !(i as unknown as { pull_request?: unknown }).pull_request);
    all.push(...issues);

    if (batch.length < 100) break;
    page++;
    if (page > 20) break; // safety cap at 2000 issues
  }
  return all;
}

export async function listIssueComments(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number | string
): Promise<GithubComment[]> {
  return githubFetch(
    token, 'GET',
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`
  ) as Promise<GithubComment[]>;
}

export async function patchIssue(
  token: string,
  owner: string,
  repo: string,
  number: number | string,
  patch: Record<string, unknown>
): Promise<GithubIssue> {
  return githubFetch(token, 'PATCH', `/repos/${owner}/${repo}/issues/${number}`, patch) as Promise<GithubIssue>;
}

export async function getIssue(
  token: string,
  owner: string,
  repo: string,
  number: number | string
): Promise<GithubIssue> {
  return githubFetch(token, 'GET', `/repos/${owner}/${repo}/issues/${number}`) as Promise<GithubIssue>;
}

export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[]
): Promise<GithubIssue> {
  const payload: Record<string, unknown> = { title };
  if (body?.trim()) payload.body = body.trim();
  if (labels?.length) payload.labels = labels;
  return githubFetch(token, 'POST', `/repos/${owner}/${repo}/issues`, payload) as Promise<GithubIssue>;
}

export async function createComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number | string,
  body: string
): Promise<GithubComment> {
  return githubFetch(
    token, 'POST',
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body }
  ) as Promise<GithubComment>;
}

export interface GithubMilestone {
  number: number;
  title: string;
  state: 'open' | 'closed';
  open_issues: number;
  closed_issues: number;
}

export async function listMilestones(
  token: string,
  owner: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'all'
): Promise<GithubMilestone[]> {
  return githubFetch(
    token, 'GET',
    `/repos/${owner}/${repo}/milestones?state=${state}&per_page=100`
  ) as Promise<GithubMilestone[]>;
}

export async function setIssueMilestone(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number | string,
  milestoneNumber: number | null
): Promise<GithubIssue> {
  return githubFetch(
    token, 'PATCH',
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    { milestone: milestoneNumber }
  ) as Promise<GithubIssue>;
}

export async function createMilestone(
  token: string,
  owner: string,
  repo: string,
  title: string
): Promise<GithubMilestone> {
  return githubFetch(
    token, 'POST',
    `/repos/${owner}/${repo}/milestones`,
    { title }
  ) as Promise<GithubMilestone>;
}
