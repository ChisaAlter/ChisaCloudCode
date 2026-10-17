# Data Model: Workspace Scheduled Prompts

## WorkspaceTask

- **Purpose**: Represents one saved scheduled prompt owned by exactly one workspace.
- **Fields**:
  - `id`: stable unique identifier
  - `workspaceKey`: stable hash derived from the workspace path
  - `workspacePath`: canonical workspace path used for validation
  - `name`: user-visible task name
  - `prompt`: full prompt body to submit for execution
  - `scheduleType`: `one_time | daily | weekdays | weekly | monthly`
  - `scheduleConfig`: cadence-specific fields
  - `timezone`: IANA timezone string used for recurrence evaluation
  - `enabled`: boolean active flag
  - `nextRunAt`: next planned occurrence timestamp or `null`
  - `lastRunStatus`: latest known run status summary
  - `createdAt`
  - `updatedAt`
- **Validation**:
  - `name` and `prompt` are required and non-empty after trimming
  - `workspacePath` must match the current workspace context when the task is mutated
  - `scheduleConfig` must be valid for the selected `scheduleType`
  - monthly schedules must resolve nonexistent days with one documented fallback behavior
- **State transitions**:
  - `draft -> enabled`
  - `enabled -> paused`
  - `paused -> enabled`
  - `enabled|paused -> deleted`

## ScheduleConfig

- **Purpose**: Encodes the bounded recurrence rule for a task without exposing arbitrary cron
  syntax.
- **Fields**:
  - `localTime`: `HH:mm`
  - `runAt`: timestamp for one-time schedules
  - `weekdays`: array of selected weekdays for weekday schedules
  - `dayOfWeek`: weekday for weekly schedules
  - `dayOfMonth`: numeric day for monthly schedules
  - `monthlyOverflowPolicy`: documented fallback for short months
- **Validation**:
  - one-time tasks require `runAt`
  - recurring tasks require `localTime`
  - weekday schedules require at least one selected weekday
  - weekly schedules require exactly one weekday
  - monthly schedules require `dayOfMonth` in the supported range

## ScheduledRun

- **Purpose**: Records one occurrence of a task, including successful runs, failures, and missed
  occurrences.
- **Fields**:
  - `id`: stable run identifier
  - `taskId`: owning task identifier
  - `workspaceKey`
  - `scheduledFor`: target occurrence time
  - `startedAt`: actual execution start time or `null`
  - `finishedAt`: completion time or `null`
  - `status`: `scheduled | running | succeeded | failed | missed | canceled`
  - `outcomeSummary`: short user-readable result
  - `failureReason`: optional detailed error summary
  - `retryOfRunId`: optional linkage for manual retries
  - `executionRequest`: serialized agent execution metadata used for auditability
- **Validation**:
  - only one run may exist per task occurrence key
  - `missed` runs do not have `startedAt`
  - `succeeded` and `failed` runs require `finishedAt`
- **State transitions**:
  - `scheduled -> running`
  - `scheduled -> missed`
  - `running -> succeeded`
  - `running -> failed`
  - `failed -> scheduled` only through explicit retry that creates a new run record

## ExecutionProfile

- **Purpose**: Stores the execution settings required to dispatch a task through a local CLI
  command launched in the workspace.
- **Fields**:
  - `workspaceKey`
  - `command`
  - `args`: ordered argument template strings
  - `timeoutMs`
  - `mode`: `local_command`
  - `lastValidatedAt`
  - `validationStatus`: `ready | needs_config | invalid | unsupported`
- **Validation**:
  - local mode requires a non-empty `command`
  - `args` must be serializable string values
  - `timeoutMs` must stay within a documented safe range

## WorkspaceLedger

- **Purpose**: Top-level persisted document for one workspace partition.
- **Fields**:
  - `workspaceKey`
  - `workspacePath`
  - `tasks`: array of `WorkspaceTask`
  - `runs`: array of `ScheduledRun`
  - `executionProfile`: `ExecutionProfile | null`
  - `updatedAt`
- **Validation**:
  - task identifiers are unique within the workspace
  - run identifiers are unique within the workspace
  - tasks and runs must all belong to the same `workspaceKey`
