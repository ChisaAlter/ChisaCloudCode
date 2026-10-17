# Global Dashboard Behavior Contract

## Purpose

Define the user-visible behavior of the dedicated global dashboard independently from transport or
implementation details.

## Scope

- The dashboard is a dedicated global tab, separate from workspace-specific views.
- It aggregates all jobs from known persisted workspaces.
- It supports direct per-job actions limited to:
  - `Run Now`
  - `Pause`
  - `Resume`
  - `Retry`
- Each row also exposes a drilldown affordance back to the source workspace view so a user can
  jump from the global overview into the workspace context when needed.

## Snapshot Semantics

- The dashboard represents a generated snapshot, not a real-time stream.
- The snapshot must include:
  - a generated timestamp
  - global summary counters
  - a per-job list
  - per-workspace availability states
  - a partial-data signal when one or more workspaces could not be read cleanly

## Status Semantics

- A job with no prior run history is treated as `never_run`.
- A paused job remains visible and distinguishable from failed or missed jobs.
- A job can be considered problematic when it is failed, missed, paused, tied to a degraded
  workspace, or otherwise lacks an expected usable next run.

## Availability Semantics

- `available`: workspace data was read successfully
- `partial`: some workspace data was read, but warnings or incomplete details exist
- `unavailable`: workspace metadata is known, but the workspace or its ledger could not be fully
  used

Jobs already known for degraded workspaces remain visible whenever enough metadata exists to render
them safely.

## Refresh Semantics

- The dashboard refreshes automatically on a periodic cadence.
- The dashboard also exposes an explicit manual refresh action.
- Automatic refresh is sufficient for `v0.2.0`; no live event subscription is required.

## Action Semantics

- `Run Now` targets the selected job in its source workspace.
- `Pause` and `Resume` toggle the selected job in its source workspace.
- `Retry` targets the latest failed or missed run surfaced as actionable for that job.
- Structural actions such as edit, delete, and duplicate are out of scope for the global dashboard
  in `v0.2.0`.
