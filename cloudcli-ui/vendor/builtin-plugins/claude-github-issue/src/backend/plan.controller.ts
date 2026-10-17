import * as configService from './config.service';
import * as planService from './plan.service';
import * as issuesService from './issues.service';
import {
  listMilestones,
  setIssueMilestone,
  createMilestone,
} from './github.service';
import type { GithubIssue } from '../../src/frontend/types';
import type { PlanData, PlanPhase } from '../../src/frontend/types';

const NO_PHASE = '__no_phase__';

async function requireConfig(projectPath: string) {
  const config = await configService.readConfig(projectPath);
  if (!config) {
    const err = new Error('GitHub not configured') as Error & { notConfigured?: boolean };
    err.notConfigured = true;
    throw err;
  }
  return config;
}

/** GET /plan — merge issues + milestones + order store into phase-grouped data. */
export async function buildPlan(projectPath: string): Promise<PlanData> {
  const config = await requireConfig(projectPath);
  // Reuse the board's cached issues + a cached milestone list so the Plan tab loads
  // instantly when the board was already fetched (and across its 30s polling).
  const [issues, milestones, store, phaseOrder] = await Promise.all([
    issuesService.getCachedRepoIssues(config),
    issuesService.getCachedMilestones(config),
    planService.readPlan(projectPath),
    planService.readPhaseOrder(projectPath),
  ]);

  // Group issues by milestone number (or NO_PHASE).
  const groups = new Map<string, GithubIssue[]>();
  for (const issue of issues) {
    const key = issue.milestone ? String(issue.milestone.number) : NO_PHASE;
    const arr = groups.get(key) ?? [];
    arr.push(issue);
    groups.set(key, arr);
  }

  const orderOf = (num: number): number => {
    const entry = store[String(num)];
    return entry ? entry.order : Number.MAX_SAFE_INTEGER;
  };
  const sortGroup = (arr: GithubIssue[]): GithubIssue[] =>
    arr.sort((a, b) => {
      const oa = orderOf(a.number);
      const ob = orderOf(b.number);
      if (oa !== ob) return oa - ob;          // explicit order first
      return a.number - b.number;             // fallback: by number
    });

  const phases: PlanPhase[] = [];

  // One section per milestone, in GitHub milestone order.
  for (const m of milestones) {
    const arr = sortGroup(groups.get(String(m.number)) ?? []);
    phases.push({
      title: m.title,
      milestoneNumber: m.number,
      total: arr.length,
      closed: arr.filter(i => i.state === 'closed').length,
      issues: arr,
    });
  }

  // Apply manual phase order (list of milestone titles). Stable sort: phases not
  // in the list keep their GitHub milestone order after the explicitly-ranked ones.
  if (phaseOrder.length > 0) {
    const rank = (title: string): number => {
      const i = phaseOrder.indexOf(title);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    phases.sort((a, b) => rank(a.title) - rank(b.title));
  }

  // "No phase" section at the bottom, only if non-empty.
  const noPhase = sortGroup(groups.get(NO_PHASE) ?? []);
  if (noPhase.length > 0) {
    phases.push({
      title: 'No phase',
      milestoneNumber: null,
      total: noPhase.length,
      closed: noPhase.filter(i => i.state === 'closed').length,
      issues: noPhase,
    });
  }

  return { phases };
}

/** PUT /plan/order — persist a new order for one phase. */
export async function saveOrder(
  projectPath: string,
  phase: string | null,
  issueNumbers: number[]
): Promise<void> {
  await requireConfig(projectPath);
  await planService.setOrder(projectPath, phase, issueNumbers);
}

/** PUT /plan/phase-order — persist the manual ordering of whole phases. */
export async function savePhaseOrder(
  projectPath: string,
  titles: string[]
): Promise<void> {
  await requireConfig(projectPath);
  await planService.setPhaseOrder(projectPath, titles);
}

/** PUT /plan/phase — assign an issue to a milestone (or clear it). */
export async function assignPhase(
  projectPath: string,
  issueNumber: number,
  milestoneNumber: number | null
): Promise<void> {
  const config = await requireConfig(projectPath);
  await setIssueMilestone(config.token, config.owner, config.repo, issueNumber, milestoneNumber);
  issuesService.invalidateRepo(config); // issue.milestone changed → drop stale caches
}

/** POST /plan/bootstrap — create missing milestones and assign issues to them. */
export async function bootstrap(
  projectPath: string,
  phases: Array<{ title: string; issues: number[] }>
): Promise<{ created: string[]; assigned: number }> {
  const config = await requireConfig(projectPath);
  const existing = await listMilestones(config.token, config.owner, config.repo, 'all');
  const byTitle = new Map(existing.map(m => [m.title, m.number] as const));
  const created: string[] = [];
  let assigned = 0;

  for (const phase of phases) {
    let num = byTitle.get(phase.title);
    if (num === undefined) {
      const m = await createMilestone(config.token, config.owner, config.repo, phase.title);
      num = m.number;
      byTitle.set(phase.title, num);
      created.push(phase.title);
    }
    for (const issueNumber of phase.issues) {
      await setIssueMilestone(config.token, config.owner, config.repo, issueNumber, num);
      assigned++;
    }
  }
  if (created.length || assigned) issuesService.invalidateRepo(config);
  return { created, assigned };
}
