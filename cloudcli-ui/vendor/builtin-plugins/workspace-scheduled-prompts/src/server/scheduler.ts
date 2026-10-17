import { randomUUID } from "node:crypto";
import type {
  CreateTaskRequest,
  ExecutionProfileRequest,
  UpdateTaskRequest,
  WorkspaceStateResponse
} from "../shared/contracts.js";
import type {
  ExecutionCapability,
  ExecutionProfile,
  RunStatus,
  ScheduledRun,
  WorkspaceLedger,
  WorkspaceTask
} from "../shared/model.js";
import { RUN_HISTORY_LIMIT } from "../shared/model.js";
import { normalizeWorkspacePath } from "../shared/workspace.js";
import {
  computeTaskNextRun,
  formatRecurrenceSummary,
  occurrenceKeyForTask,
  validateRecurrenceDefinition
} from "./recurrence.js";
import { LocalExecutionAdapter } from "./execution-adapter.js";
import { createExecutionProfile, normalizeExecutionProfile, resolveExecutionCapability } from "./settings.js";
import { listWorkspaceLedgers, loadWorkspaceLedger, saveWorkspaceLedger } from "./storage.js";

const EXECUTION_GRACE_WINDOW_MS = 90_000;

function nowIso(): string {
  return new Date().toISOString();
}

function sortRunsDesc(runs: ScheduledRun[]): ScheduledRun[] {
  return [...runs].sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));
}

function trimRuns(runs: ScheduledRun[]): ScheduledRun[] {
  return sortRunsDesc(runs).slice(0, RUN_HISTORY_LIMIT);
}

function taskWithComputedFields(task: WorkspaceTask, afterIso?: string): WorkspaceTask {
  return {
    ...task,
    recurrenceSummary: formatRecurrenceSummary(task.recurrence),
    nextRunAt: computeTaskNextRun(task, afterIso)
  };
}

function createRun(task: WorkspaceTask, scheduledFor: string, status: RunStatus, outcomeSummary: string): ScheduledRun {
  return {
    id: randomUUID(),
    occurrenceKey: occurrenceKeyForTask(task.id, scheduledFor),
    taskId: task.id,
    workspaceKey: task.workspaceKey,
    scheduledFor,
    startedAt: status === "running" ? nowIso() : null,
    finishedAt: status === "running" ? null : nowIso(),
    status,
    outcomeSummary,
    failureReason: status === "failed" || status === "missed" ? outcomeSummary : null,
    retryOfRunId: null,
    executionRequest: null
  };
}

function createRunningRun(task: WorkspaceTask, scheduledFor: string): ScheduledRun {
  return {
    id: randomUUID(),
    occurrenceKey: occurrenceKeyForTask(task.id, scheduledFor),
    taskId: task.id,
    workspaceKey: task.workspaceKey,
    scheduledFor,
    startedAt: nowIso(),
    finishedAt: null,
    status: "running",
    outcomeSummary: "Command started.",
    failureReason: null,
    retryOfRunId: null,
    executionRequest: null
  };
}

function isOutsideExecutionGraceWindow(scheduledFor: string, referenceIso: string): boolean {
  const scheduledAt = Date.parse(scheduledFor);
  const referenceAt = Date.parse(referenceIso);
  if (Number.isNaN(scheduledAt) || Number.isNaN(referenceAt)) {
    return true;
  }
  return referenceAt - scheduledAt > EXECUTION_GRACE_WINDOW_MS;
}

export class SchedulerService {
  private readonly executionAdapter: LocalExecutionAdapter;
  private readonly inFlightOccurrences = new Set<string>();

  constructor(executionAdapter = new LocalExecutionAdapter()) {
    this.executionAdapter = executionAdapter;
  }

  async loadWorkspaceState(workspacePath: string, capability: ExecutionCapability): Promise<WorkspaceStateResponse> {
    const ledger = await this.refreshWorkspaceLedger(workspacePath);
    return {
      capability,
      executionProfile: ledger.executionProfile,
      tasks: ledger.tasks,
      runs: sortRunsDesc(ledger.runs)
    };
  }

  async listRuns(workspacePath: string, limit = RUN_HISTORY_LIMIT): Promise<ScheduledRun[]> {
    const ledger = await this.refreshWorkspaceLedger(workspacePath);
    return sortRunsDesc(ledger.runs).slice(0, limit);
  }

  async createTask(request: CreateTaskRequest): Promise<WorkspaceTask> {
    validateRecurrenceDefinition(request.recurrence);
    const ledger = await loadWorkspaceLedger(request.workspacePath);
    const createdAt = nowIso();

    const task: WorkspaceTask = taskWithComputedFields(
      {
        id: randomUUID(),
        workspaceKey: ledger.workspaceKey,
        workspacePath: normalizeWorkspacePath(request.workspacePath),
        name: request.name.trim(),
        prompt: request.prompt.trim(),
        recurrence: request.recurrence,
        recurrenceSummary: "",
        enabled: true,
        nextRunAt: null,
        lastRunStatus: null,
        createdAt,
        updatedAt: createdAt
      },
      createdAt
    );

    ledger.tasks.push(task);
    await saveWorkspaceLedger(ledger);
    return task;
  }

  async updateTask(taskId: string, request: UpdateTaskRequest): Promise<WorkspaceTask> {
    const ledger = await loadWorkspaceLedger(request.workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    if (request.recurrence) {
      validateRecurrenceDefinition(request.recurrence);
      task.recurrence = request.recurrence;
    }
    if (request.name !== undefined) {
      task.name = request.name.trim();
    }
    if (request.prompt !== undefined) {
      task.prompt = request.prompt.trim();
    }
    if (request.enabled !== undefined) {
      task.enabled = request.enabled;
    }

    task.updatedAt = nowIso();
    const updated = taskWithComputedFields(task, task.updatedAt);
    Object.assign(task, updated);
    await saveWorkspaceLedger(ledger);
    return task;
  }

  async deleteTask(taskId: string, workspacePath: string): Promise<void> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    ledger.tasks = ledger.tasks.filter((task) => task.id !== taskId);
    await saveWorkspaceLedger(ledger);
  }

  async pauseTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: false });
  }

  async resumeTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    return this.updateTask(taskId, { workspacePath, enabled: true });
  }

  async duplicateTask(taskId: string, workspacePath: string): Promise<WorkspaceTask> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const source = ledger.tasks.find((task) => task.id === taskId);
    if (!source) {
      throw new Error("Task not found");
    }

    const copy = taskWithComputedFields(
      {
        ...source,
        id: randomUUID(),
        name: `${source.name} (Copy)`,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastRunStatus: null
      },
      nowIso()
    );

    ledger.tasks.push(copy);
    await saveWorkspaceLedger(ledger);
    return copy;
  }

  async createManualRun(taskId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const task = ledger.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    const scheduledFor = nowIso();
    const run = await this.executeTask(ledger, task, scheduledFor, {
      manual: true
    });
    return run;
  }

  async retryRun(runId: string, workspacePath: string): Promise<ScheduledRun> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    const existing = ledger.runs.find((run) => run.id === runId);
    if (!existing) {
      throw new Error("Run not found");
    }

    const task = ledger.tasks.find((entry) => entry.id === existing.taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    return this.executeTask(ledger, task, nowIso(), {
      manual: true,
      retryOfRunId: existing.id
    });
  }

  async saveExecutionProfile(request: ExecutionProfileRequest): Promise<ExecutionProfile> {
    const ledger = await loadWorkspaceLedger(request.workspacePath);
    ledger.executionProfile = createExecutionProfile({
      workspaceKey: ledger.workspaceKey,
      command: request.command,
      args: request.args,
      timeoutMs: request.timeoutMs
    });
    await saveWorkspaceLedger(ledger);
    return ledger.executionProfile;
  }

  async refreshWorkspaceLedger(workspacePath: string): Promise<WorkspaceLedger> {
    const ledger = await loadWorkspaceLedger(workspacePath);
    let changed = false;
    const normalizedProfile = normalizeExecutionProfile(ledger.executionProfile);
    if (JSON.stringify(normalizedProfile) !== JSON.stringify(ledger.executionProfile)) {
      ledger.executionProfile = normalizedProfile;
      changed = true;
    }
    for (const task of ledger.tasks) {
      const nextRunAt = computeTaskNextRun(task, nowIso());
      if (task.nextRunAt !== nextRunAt || task.recurrenceSummary !== formatRecurrenceSummary(task.recurrence)) {
        task.nextRunAt = nextRunAt;
        task.recurrenceSummary = formatRecurrenceSummary(task.recurrence);
        changed = true;
      }
    }
    if (changed) {
      await saveWorkspaceLedger(ledger);
    }
    return ledger;
  }

  async tickWithoutDispatcher(): Promise<void> {
    const ledgers = await listWorkspaceLedgers();
    for (const ledger of ledgers) {
      const tickStartedAt = nowIso();
      let changed = false;
      const capability = resolveExecutionCapability(ledger.executionProfile ?? null);
      for (const task of ledger.tasks) {
        if (!task.enabled || !task.nextRunAt) {
          continue;
        }

        while (task.nextRunAt && task.nextRunAt <= tickStartedAt) {
          const scheduledFor = task.nextRunAt;
          const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
          const alreadyTracked =
            this.inFlightOccurrences.has(occurrenceKey) ||
            ledger.runs.some((run) => run.occurrenceKey === occurrenceKey);

          if (alreadyTracked) {
            task.nextRunAt = computeTaskNextRun(task, scheduledFor);
            changed = true;
            continue;
          }

          if (capability.status !== "ready" || isOutsideExecutionGraceWindow(scheduledFor, tickStartedAt)) {
            const missedReason =
              capability.status !== "ready"
                ? capability.message
                : "Automatic execution was unavailable at the scheduled time.";
            this.recordMissedRun(ledger, task, scheduledFor, missedReason);
            changed = true;
            continue;
          }

          await this.executeTask(ledger, task, scheduledFor);
          changed = false;
          break;
        }
      }

      if (changed) {
        await saveWorkspaceLedger(ledger);
      }
    }
  }

  private recordMissedRun(ledger: WorkspaceLedger, task: WorkspaceTask, scheduledFor: string, reason: string): void {
    const missedRun = createRun(task, scheduledFor, "missed", reason);
    missedRun.failureReason = reason;
    ledger.runs = trimRuns([missedRun, ...ledger.runs]);
    task.lastRunStatus = "missed";
    task.nextRunAt = computeTaskNextRun(task, scheduledFor);
  }

  private async executeTask(
    ledger: WorkspaceLedger,
    task: WorkspaceTask,
    scheduledFor: string,
    options?: { manual?: boolean; retryOfRunId?: string | null }
  ): Promise<ScheduledRun> {
    const occurrenceKey = occurrenceKeyForTask(task.id, scheduledFor);
    if (this.inFlightOccurrences.has(occurrenceKey)) {
      throw new Error("This occurrence is already running.");
    }

    const profile = ledger.executionProfile;
    const capability = resolveExecutionCapability(profile ?? null);

    if (capability.status !== "ready" || !profile) {
      const blockedStatus: RunStatus = options?.manual ? "failed" : "missed";
      const blockedSummary = options?.manual
        ? `Manual execution could not start. ${capability.message}`
        : capability.message;
      const blockedRun = createRun(task, scheduledFor, blockedStatus, blockedSummary);
      blockedRun.retryOfRunId = options?.retryOfRunId ?? null;
      ledger.runs = trimRuns([blockedRun, ...ledger.runs]);
      task.lastRunStatus = blockedStatus;
      if (!options?.manual) {
        task.nextRunAt = computeTaskNextRun(task, scheduledFor);
      }
      await saveWorkspaceLedger(ledger);
      return blockedRun;
    }

    this.inFlightOccurrences.add(occurrenceKey);
    const run = createRunningRun(task, scheduledFor);
    const executionRequest = this.executionAdapter.createRequest(task, profile, scheduledFor);
    run.retryOfRunId = options?.retryOfRunId ?? null;
    run.executionRequest = executionRequest;

    if (!options?.manual) {
      task.nextRunAt = computeTaskNextRun(task, scheduledFor);
    }
    ledger.runs = trimRuns([run, ...ledger.runs]);
    task.lastRunStatus = "running";
    await saveWorkspaceLedger(ledger);

    try {
      const result = await this.executionAdapter.execute(task, profile, scheduledFor, executionRequest);
      run.status = result.status;
      run.finishedAt = nowIso();
      run.outcomeSummary = result.outcomeSummary;
      run.failureReason = result.failureReason;
      run.executionRequest = result.executionRequest;
      task.lastRunStatus = result.status;
      await saveWorkspaceLedger(ledger);
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local command execution failed.";
      run.status = "failed";
      run.finishedAt = nowIso();
      run.outcomeSummary = message;
      run.failureReason = message;
      task.lastRunStatus = "failed";
      await saveWorkspaceLedger(ledger);
      return run;
    } finally {
      this.inFlightOccurrences.delete(occurrenceKey);
    }
  }
}
