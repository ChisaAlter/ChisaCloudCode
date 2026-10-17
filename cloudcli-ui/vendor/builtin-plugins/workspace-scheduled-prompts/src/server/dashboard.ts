import type {
  GlobalDashboardAction,
  GlobalDashboardFilter,
  GlobalDashboardSnapshot,
  GlobalDashboardSummary,
  GlobalDashboardStatusFilter,
  GlobalJobRecord,
  GlobalJobRunStatus,
  ScheduledRun,
  WorkspaceAvailability,
  WorkspaceLedger,
  WorkspaceTask
} from "../shared/model.js";
import { listWorkspaceLedgerRecords, type WorkspaceLedgerRecord } from "./storage.js";

function latestRunsByTaskId(runs: ScheduledRun[]): Map<string, ScheduledRun[]> {
  const grouped = new Map<string, ScheduledRun[]>();
  const sorted = [...runs].sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));

  for (const run of sorted) {
    const existing = grouped.get(run.taskId) ?? [];
    existing.push(run);
    grouped.set(run.taskId, existing);
  }

  return grouped;
}

function storedTaskStatus(task: WorkspaceTask): GlobalJobRunStatus {
  switch (task.lastRunStatus) {
    case "running":
    case "succeeded":
    case "failed":
    case "missed":
      return task.lastRunStatus;
    default:
      return "never_run";
  }
}

function deriveTaskStatus(
  task: WorkspaceTask,
  runs: ScheduledRun[],
  workspaceAvailability: WorkspaceAvailability
): GlobalJobRunStatus {
  const latest = runs[0];
  if (latest?.status === "running") {
    return "running";
  }

  if (!task.enabled) {
    return "paused";
  }

  if (!latest) {
    return storedTaskStatus(task);
  }

  if (workspaceAvailability !== "available" && latest.status === "succeeded") {
    return "succeeded";
  }

  switch (latest.status) {
    case "succeeded":
    case "failed":
    case "missed":
      return latest.status;
    default:
      return storedTaskStatus(task);
  }
}

function findLatestActionableRunId(runs: ScheduledRun[]): string | null {
  const latest = runs[0];
  if (!latest) {
    return null;
  }

  return latest.status === "failed" || latest.status === "missed" ? latest.id : null;
}

function buildAvailableActions(task: WorkspaceTask, latestActionableRunId: string | null): GlobalDashboardAction[] {
  const actions: GlobalDashboardAction[] = ["run_now"];
  actions.push(task.enabled ? "pause" : "resume");
  if (latestActionableRunId) {
    actions.push("retry");
  }
  return actions;
}

function buildJobRecord(
  ledgerRecord: WorkspaceLedgerRecord,
  ledger: WorkspaceLedger,
  task: WorkspaceTask,
  taskRuns: ScheduledRun[]
): GlobalJobRecord {
  const lastRunStatus = deriveTaskStatus(task, taskRuns, ledgerRecord.status);
  const latestActionableRunId = findLatestActionableRunId(taskRuns);
  const latestFinishedRun = taskRuns.find((run) => run.finishedAt);

  return {
    taskId: task.id,
    workspaceKey: ledger.workspaceKey,
    workspacePath: ledger.workspacePath,
    workspaceLabel: ledgerRecord.workspaceLabel,
    workspaceDrilldownAvailable: ledgerRecord.status !== "unavailable",
    name: task.name,
    scheduleType: task.recurrence.scheduleType,
    recurrenceSummary: task.recurrenceSummary,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunStatus,
    lastRunFinishedAt: latestFinishedRun?.finishedAt ?? null,
    latestActionableRunId,
    workspaceAvailability: ledgerRecord.status,
    availableActions: buildAvailableActions(task, latestActionableRunId)
  };
}

export function isProblemJob(job: GlobalJobRecord): boolean {
  if (job.workspaceAvailability !== "available") {
    return true;
  }
  if (job.lastRunStatus === "failed" || job.lastRunStatus === "missed" || job.lastRunStatus === "paused") {
    return true;
  }
  if (job.lastRunStatus === "never_run") {
    return true;
  }
  if (job.scheduleType === "one_time" && job.lastRunStatus === "succeeded" && !job.nextRunAt) {
    return false;
  }
  return job.enabled && !job.nextRunAt;
}

function matchesStatusFilter(job: GlobalJobRecord, filter?: GlobalDashboardStatusFilter): boolean {
  if (!filter) {
    return true;
  }

  switch (filter) {
    case "healthy":
      return !isProblemJob(job) && job.lastRunStatus === "succeeded";
    case "problem":
      return isProblemJob(job);
    case "paused":
    case "running":
    case "failed":
    case "missed":
    case "never_run":
      return job.lastRunStatus === filter;
    default:
      return true;
  }
}

function urgencyScore(job: GlobalJobRecord): number {
  if (job.workspaceAvailability === "unavailable") {
    return 0;
  }
  if (job.workspaceAvailability === "partial") {
    return 1;
  }

  switch (job.lastRunStatus) {
    case "failed":
      return 2;
    case "missed":
      return 3;
    case "running":
      return 4;
    case "paused":
      return 5;
    case "never_run":
      return 6;
    default:
      return job.nextRunAt ? 20 : 7;
  }
}

function compareJobs(sortBy: GlobalDashboardFilter["sortBy"], left: GlobalJobRecord, right: GlobalJobRecord): number {
  switch (sortBy) {
    case "name":
      return left.name.localeCompare(right.name) || left.workspaceLabel.localeCompare(right.workspaceLabel);
    case "workspace":
      return left.workspaceLabel.localeCompare(right.workspaceLabel) || left.name.localeCompare(right.name);
    case "next_run": {
      if (left.nextRunAt && right.nextRunAt) {
        return left.nextRunAt.localeCompare(right.nextRunAt) || left.name.localeCompare(right.name);
      }
      if (left.nextRunAt) {
        return -1;
      }
      if (right.nextRunAt) {
        return 1;
      }
      return left.name.localeCompare(right.name);
    }
    case "urgency":
    default:
      return (
        urgencyScore(left) - urgencyScore(right) ||
        left.workspaceLabel.localeCompare(right.workspaceLabel) ||
        left.name.localeCompare(right.name)
      );
  }
}

function buildSummary(workspaces: WorkspaceLedgerRecord[], jobs: GlobalJobRecord[]): GlobalDashboardSummary {
  return {
    totalJobs: jobs.length,
    activeJobs: jobs.filter((job) => job.enabled).length,
    pausedJobs: jobs.filter((job) => job.lastRunStatus === "paused").length,
    problemJobs: jobs.filter((job) => isProblemJob(job)).length,
    workspacesTotal: workspaces.length,
    workspacesDegraded: workspaces.filter((workspace) => workspace.status !== "available").length
  };
}

export async function buildGlobalDashboardSnapshot(
  filter: GlobalDashboardFilter
): Promise<GlobalDashboardSnapshot> {
  const workspaceRecords = await listWorkspaceLedgerRecords();
  const scopedWorkspaces = filter.workspaceKey
    ? workspaceRecords.filter((workspace) => workspace.workspaceKey === filter.workspaceKey)
    : workspaceRecords;
  const warnings = scopedWorkspaces
    .map((workspace) => (workspace.warning ? `${workspace.workspaceLabel}: ${workspace.warning}` : null))
    .filter((warning): warning is string => Boolean(warning));

  const allJobs: GlobalJobRecord[] = [];

  for (const workspace of scopedWorkspaces) {
    const ledger = workspace.ledger;
    if (!ledger) {
      continue;
    }

    const runsByTask = latestRunsByTaskId(ledger.runs);
    for (const task of ledger.tasks) {
      allJobs.push(buildJobRecord(workspace, ledger, task, runsByTask.get(task.id) ?? []));
    }
  }

  const visibleJobs = allJobs
    .filter((job) => matchesStatusFilter(job, filter.status))
    .sort((left, right) => compareJobs(filter.sortBy, left, right));

  return {
    generatedAt: new Date().toISOString(),
    summary: buildSummary(scopedWorkspaces, allJobs),
    jobs: visibleJobs,
    workspaces: scopedWorkspaces.map((workspace) => ({
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
      workspaceLabel: workspace.workspaceLabel,
      status: workspace.status,
      jobCount: workspace.jobCount,
      warning: workspace.warning
    })),
    partialData: scopedWorkspaces.some((workspace) => workspace.status !== "available"),
    warnings
  };
}

export async function resolveGlobalWorkspacePath(workspaceKey: string): Promise<string> {
  const workspace = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === workspaceKey);
  if (!workspace?.ledger) {
    throw new Error("Workspace not found");
  }
  return workspace.ledger.workspacePath;
}

export async function resolveGlobalTask(
  workspaceKey: string,
  taskId: string
): Promise<{ workspacePath: string; task: WorkspaceTask; latestActionableRunId: string | null }> {
  const workspace = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === workspaceKey);
  if (!workspace?.ledger) {
    throw new Error("Workspace not found");
  }

  const task = workspace.ledger.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error("Task not found");
  }

  const latestActionableRunId = findLatestActionableRunId(
    workspace.ledger.runs
      .filter((run) => run.taskId === taskId)
      .sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor))
  );

  return {
    workspacePath: workspace.ledger.workspacePath,
    task,
    latestActionableRunId
  };
}

export async function readGlobalTaskState(workspaceKey: string, taskId: string): Promise<WorkspaceTask> {
  const workspace = (await listWorkspaceLedgerRecords()).find((entry) => entry.workspaceKey === workspaceKey);
  if (!workspace?.ledger) {
    throw new Error("Workspace not found");
  }

  const task = workspace.ledger.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error("Task not found");
  }

  return task;
}
