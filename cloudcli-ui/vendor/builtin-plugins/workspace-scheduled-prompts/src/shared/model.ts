export type ScheduleType = "one_time" | "daily" | "weekdays" | "weekly" | "monthly";
export type RunStatus = "scheduled" | "running" | "succeeded" | "failed" | "missed" | "canceled";
export type ExecutionCapabilityStatus = "ready" | "needs_config" | "invalid" | "unsupported";
export type MonthlyOverflowPolicy = "clamp_to_last_day";
export type WorkspaceAvailability = "available" | "partial" | "unavailable";
export type GlobalDashboardStatusFilter =
  | "healthy"
  | "problem"
  | "paused"
  | "running"
  | "failed"
  | "missed"
  | "never_run";
export type GlobalDashboardSortBy = "urgency" | "next_run" | "workspace" | "name";
export type GlobalDashboardAction = "run_now" | "pause" | "resume" | "retry";
export type GlobalJobRunStatus = "never_run" | "running" | "succeeded" | "failed" | "missed" | "paused";

export interface BaseRecurrenceDefinition {
  scheduleType: ScheduleType;
  timezone: string;
}

export interface OneTimeRecurrenceDefinition extends BaseRecurrenceDefinition {
  scheduleType: "one_time";
  runAt: string;
}

export interface DailyRecurrenceDefinition extends BaseRecurrenceDefinition {
  scheduleType: "daily";
  localTime: string;
}

export interface WeekdaysRecurrenceDefinition extends BaseRecurrenceDefinition {
  scheduleType: "weekdays";
  localTime: string;
  weekdays: WeekdayName[];
}

export interface WeeklyRecurrenceDefinition extends BaseRecurrenceDefinition {
  scheduleType: "weekly";
  localTime: string;
  dayOfWeek: WeekdayName;
}

export interface MonthlyRecurrenceDefinition extends BaseRecurrenceDefinition {
  scheduleType: "monthly";
  localTime: string;
  dayOfMonth: number;
  monthlyOverflowPolicy?: MonthlyOverflowPolicy;
}

export type RecurrenceDefinition =
  | OneTimeRecurrenceDefinition
  | DailyRecurrenceDefinition
  | WeekdaysRecurrenceDefinition
  | WeeklyRecurrenceDefinition
  | MonthlyRecurrenceDefinition;

export type WeekdayName =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface WorkspaceTask {
  id: string;
  workspaceKey: string;
  workspacePath: string;
  name: string;
  prompt: string;
  recurrence: RecurrenceDefinition;
  recurrenceSummary: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunStatus: RunStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledRun {
  id: string;
  occurrenceKey: string;
  taskId: string;
  workspaceKey: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: RunStatus;
  outcomeSummary: string;
  failureReason: string | null;
  retryOfRunId: string | null;
  executionRequest: Record<string, unknown> | null;
}

export interface ExecutionProfile {
  workspaceKey: string;
  command: string;
  args: string[];
  timeoutMs: number;
  mode: "local_command";
  lastValidatedAt: string | null;
  validationStatus: ExecutionCapabilityStatus;
}

export interface ExecutionCapability {
  status: ExecutionCapabilityStatus;
  message: string;
}

export interface WorkspaceLedger {
  version: number;
  workspaceKey: string;
  workspacePath: string;
  tasks: WorkspaceTask[];
  runs: ScheduledRun[];
  executionProfile: ExecutionProfile | null;
  updatedAt: string;
}

export interface WorkspaceAvailabilityState {
  workspaceKey: string;
  workspacePath: string;
  workspaceLabel: string;
  status: WorkspaceAvailability;
  jobCount: number;
  warning: string | null;
}

export interface GlobalJobRecord {
  taskId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceLabel: string;
  workspaceDrilldownAvailable: boolean;
  name: string;
  scheduleType: ScheduleType;
  recurrenceSummary: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunStatus: GlobalJobRunStatus;
  lastRunFinishedAt: string | null;
  latestActionableRunId: string | null;
  workspaceAvailability: WorkspaceAvailability;
  availableActions: GlobalDashboardAction[];
}

export interface GlobalDashboardSummary {
  totalJobs: number;
  activeJobs: number;
  pausedJobs: number;
  problemJobs: number;
  workspacesTotal: number;
  workspacesDegraded: number;
}

export interface GlobalDashboardFilter {
  status?: GlobalDashboardStatusFilter;
  workspaceKey?: string;
  sortBy: GlobalDashboardSortBy;
}

export interface GlobalDashboardSnapshot {
  generatedAt: string;
  summary: GlobalDashboardSummary;
  jobs: GlobalJobRecord[];
  workspaces: WorkspaceAvailabilityState[];
  partialData: boolean;
  warnings: string[];
}

export interface CrossWorkspaceActionTarget {
  workspaceKey: string;
  taskId: string;
  action: GlobalDashboardAction;
  runId?: string;
}

export const RUN_HISTORY_LIMIT = 500;
