import type { GithubIssue, GithubColumn } from '../../src/frontend/types';
import * as github from './github.service';
import * as configService from './config.service';
import { cacheGet, cacheSet, cacheDeletePrefix } from './cache';

const ISSUES_TTL = 60_000;    // 60s
const COMMENTS_TTL = 30_000;  // 30s

const STATUS_LABELS_SET = new Set(['in-progress', 'review', 'blocked', 'deferred', 'cancelled', 'need-testing']);

export interface ColumnDef {
  id: string;
  name: string;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  color?: string;
}

export const COLUMNS: ColumnDef[] = [
  { id: 'todo',        name: 'To Do',       title: 'To Do',       state: 'open',   labels: [] },
  { id: 'in-progress', name: 'In Progress', title: 'In Progress', state: 'open',   labels: ['in-progress'] },
  { id: 'review',      name: 'In Review',   title: 'In Review',   state: 'open',   labels: ['review'] },
  { id: 'blocked',     name: 'Blocked',     title: 'Blocked',     state: 'open',   labels: ['blocked'] },
  { id: 'done',        name: 'Done',        title: 'Done',        state: 'closed', labels: [] },
];

export function buildColumns(): GithubColumn[] {
  return COLUMNS.map(c => ({ id: c.id, name: c.name, labels: c.labels }));
}

export interface IssueWithColumn extends GithubIssue {
  columnId: string;
}

export function issueToColumnId(issue: GithubIssue): string {
  if (issue.state === 'closed') return 'done';
  const labelNames = new Set(issue.labels.map(l => l.name));
  for (const col of COLUMNS) {
    if (col.labels.length > 0 && col.labels.some(l => labelNames.has(l))) {
      return col.id;
    }
  }
  return 'todo';
}

export function categorizeIssues(issues: GithubIssue[]): IssueWithColumn[] {
  return issues.map(issue => ({ ...issue, columnId: issueToColumnId(issue) }));
}

export async function fetchIssues(projectPath: string): Promise<{
  issues: IssueWithColumn[];
  columns: GithubColumn[];
  owner: string;
  repo: string;
}> {
  const config = await configService.readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) {
    const err = new Error('GitHub not configured for this project') as Error & { notConfigured: boolean };
    err.notConfigured = true;
    throw err;
  }

  const cacheKey = `issues:${config.owner}/${config.repo}`;
  const cached = cacheGet(cacheKey) as { issues: IssueWithColumn[]; columns: GithubColumn[]; owner: string; repo: string } | null;
  if (cached) return cached;

  const raw = await github.listIssues(config.token, config.owner, config.repo, 'all');
  const issues = categorizeIssues(raw);
  const result = { issues, columns: buildColumns(), owner: config.owner, repo: config.repo };
  cacheSet(cacheKey, result, ISSUES_TTL);
  return result;
}

/**
 * Cached repo issues keyed by owner/repo — the SAME cache the board uses. The Plan
 * tab reuses this so switching tabs (or polling) doesn't re-paginate GitHub each time.
 */
export async function getCachedRepoIssues(
  config: { token: string; owner: string; repo: string }
): Promise<IssueWithColumn[]> {
  const cacheKey = `issues:${config.owner}/${config.repo}`;
  const cached = cacheGet(cacheKey) as { issues: IssueWithColumn[] } | null;
  if (cached) return cached.issues;

  const raw = await github.listIssues(config.token, config.owner, config.repo, 'all');
  const issues = categorizeIssues(raw);
  cacheSet(cacheKey, { issues, columns: buildColumns(), owner: config.owner, repo: config.repo }, ISSUES_TTL);
  return issues;
}

/** Cached milestone list (Plan polls every 30s; milestones rarely change). */
export async function getCachedMilestones(
  config: { token: string; owner: string; repo: string }
): Promise<github.GithubMilestone[]> {
  const cacheKey = `milestones:${config.owner}/${config.repo}`;
  const cached = cacheGet(cacheKey) as github.GithubMilestone[] | null;
  if (cached) return cached;

  const milestones = await github.listMilestones(config.token, config.owner, config.repo, 'all');
  cacheSet(cacheKey, milestones, ISSUES_TTL);
  return milestones;
}

/** Drop both repo-scoped caches — call after any write that changes issues/milestones. */
export function invalidateRepo(config: { owner: string; repo: string }): void {
  cacheDeletePrefix(`issues:${config.owner}/${config.repo}`);
  cacheDeletePrefix(`milestones:${config.owner}/${config.repo}`);
}

export async function fetchComments(projectPath: string, issueNumber: string | number) {
  const config = await configService.readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) return [];

  const cacheKey = `comments:${config.owner}/${config.repo}:${issueNumber}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const comments = await github.listIssueComments(config.token, config.owner, config.repo, issueNumber);
  cacheSet(cacheKey, comments, COMMENTS_TTL);
  return comments;
}

export async function addComment(projectPath: string, issueNumber: string | number, body: string) {
  const config = await configService.readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) throw new Error('Not configured');

  const comment = await github.createComment(config.token, config.owner, config.repo, issueNumber, body);
  cacheDeletePrefix(`comments:${config.owner}/${config.repo}:${issueNumber}`);
  return comment;
}

export async function createIssue(
  projectPath: string,
  title: string,
  body?: string,
  labels?: string[]
): Promise<GithubIssue> {
  const config = await configService.readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) throw new Error('Not configured');
  const issue = await github.createIssue(config.token, config.owner, config.repo, title, body, labels);
  cacheDeletePrefix(`issues:${config.owner}/${config.repo}`);
  return issue;
}

export async function updateIssue(
  projectPath: string,
  issueNumber: string | number,
  { state, addLabels, removeLabels, labels, title }: {
    state?: string;
    addLabels?: string[];
    removeLabels?: string[];
    labels?: string[];
    title?: string;
  }
) {
  const config = await configService.readConfig(projectPath);
  if (!config?.token || !config?.owner || !config?.repo) throw new Error('Not configured');

  const patch: Record<string, unknown> = {};
  if (state !== undefined) patch.state = state;
  if (title !== undefined) patch.title = title;

  if (labels !== undefined) {
    patch.labels = labels;
  } else if (addLabels?.length || removeLabels?.length) {
    const current = await github.getIssue(config.token, config.owner, config.repo, issueNumber);
    const currentLabels = (current.labels || []).map(l => l.name);
    const filtered = currentLabels.filter(l => !(removeLabels ?? []).includes(l));
    patch.labels = [...new Set([...filtered, ...(addLabels ?? [])])];
  }

  const updated = await github.patchIssue(config.token, config.owner, config.repo, issueNumber, patch);
  cacheDeletePrefix(`issues:${config.owner}/${config.repo}`);
  return updated;
}
