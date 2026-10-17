# Data Model: Global Job Dashboard

## GlobalDashboardSnapshot

- **Purpose**: Top-level response model for the dedicated global dashboard view.
- **Fields**:
  - `generatedAt`: timestamp of the snapshot
  - `summary`: `GlobalDashboardSummary`
  - `jobs`: array of `GlobalJobRecord`
  - `workspaces`: array of `WorkspaceAvailabilityState`
  - `partialData`: boolean flag indicating one or more workspace reads were degraded
  - `warnings`: array of user-readable warning strings for partial or degraded reads
- **Validation**:
  - `jobs` must include only records successfully derived from readable workspace ledgers
  - `partialData` must be `true` whenever one or more workspaces are unreadable or partially
    readable

## GlobalJobRecord

- **Purpose**: Consolidated representation of one scheduled job inside the global dashboard.
- **Fields**:
  - `taskId`: stable job identifier from the workspace ledger
  - `workspaceKey`: stable workspace identifier
  - `workspacePath`: last known canonical workspace path
  - `workspaceLabel`: user-readable workspace name or derived path label
  - `name`: job name
  - `recurrenceSummary`: human-readable schedule summary
  - `enabled`: whether the job is active
  - `nextRunAt`: next planned occurrence or `null`
  - `lastRunStatus`: latest known run status or `never_run`
  - `lastRunFinishedAt`: completion timestamp of the latest completed run if any
  - `latestActionableRunId`: latest failed or missed run identifier eligible for retry, or `null`
  - `workspaceAvailability`: `available | partial | unavailable`
  - `availableActions`: subset of `run_now | pause | resume | retry`
- **Validation**:
  - `(workspaceKey, taskId)` must be unique across the snapshot
  - `retry` can only appear in `availableActions` when `latestActionableRunId` is present
  - `pause` and `resume` are mutually exclusive for a given record

## WorkspaceAvailabilityState

- **Purpose**: Communicates whether a workspace contributing to the global dashboard is fully
  readable, partially readable, or unavailable.
- **Fields**:
  - `workspaceKey`
  - `workspacePath`
  - `workspaceLabel`
  - `status`: `available | partial | unavailable`
  - `jobCount`: number of readable jobs surfaced for that workspace
  - `warning`: optional short explanation for degraded state
- **Validation**:
  - `warning` is required when `status` is `partial` or `unavailable`
  - `jobCount` may be `0` for unavailable workspaces whose metadata is still known

## GlobalDashboardSummary

- **Purpose**: Aggregated counters shown at the top of the dashboard.
- **Fields**:
  - `totalJobs`
  - `activeJobs`
  - `pausedJobs`
  - `problemJobs`: jobs requiring action (`failed`, `missed`, unavailable workspace, or no usable
    next run when one is expected)
  - `workspacesTotal`
  - `workspacesDegraded`
- **Validation**:
  - Counters must be derived from the same snapshot as `jobs`
  - `problemJobs` must reflect the same urgency rules used for filters and highlighting

## GlobalDashboardFilter

- **Purpose**: Represents the server-supported and client-visible filter state for the dashboard.
- **Fields**:
  - `status`: optional filter across `healthy | problem | paused | running | failed | missed |
    never_run`
  - `workspaceKey`: optional workspace filter
  - `sortBy`: `urgency | next_run | workspace | name`
- **Validation**:
  - Filter values must map to deterministic subsets of `GlobalJobRecord`
  - `urgency` ordering must prioritize actionable or degraded records before healthy ones

## CrossWorkspaceActionTarget

- **Purpose**: Canonical identity for invoking direct actions from the global dashboard.
- **Fields**:
  - `workspaceKey`
  - `taskId`
  - `runId`: optional, used for `retry`
  - `action`: `run_now | pause | resume | retry`
- **Validation**:
  - `runId` is required for `retry`
  - `runId` must belong to the same workspace and task as the targeted record
