# Quickstart: Global Job Dashboard

## Documentation anchor

- `README.md` should expose a `Global Dashboard` section while this feature is in progress.

## Prerequisites

- Node.js 18+ available locally
- Existing `v0.1.0` plugin installed and working
- At least two known workspaces already persisted by the plugin
- At least one workspace containing a failed, missed, paused, or otherwise actionable job

## Local development

1. Install dependencies:

```bash
npm install
```

2. Build the plugin:

```bash
npm run build
```

3. Run the test suite:

```bash
npm test
```

## Validate the global dashboard

### Open the dedicated global tab

1. Launch the plugin host.
2. Open the `Scheduled Prompt` plugin.
3. Select the dedicated global dashboard tab.
4. Confirm the view loads without selecting a specific workspace first.

### Verify cross-workspace aggregation

1. Ensure two or more workspaces already have persisted jobs.
2. Open the global dashboard.
3. Confirm jobs from all known workspaces appear in one table or list.
4. Confirm each row shows at least:
   - job name
   - workspace
   - latest status
   - next run
   - recurrence summary

### Verify filtering and urgency ordering

1. Populate a mix of healthy, paused, failed, missed, and never-run jobs.
2. Confirm the dashboard summary counters reflect the full set.
3. Apply a status filter for problematic jobs.
4. Confirm only matching jobs remain visible.
5. Clear the filter and confirm urgent or actionable jobs remain visually prominent.

### Verify direct global actions

1. Choose a paused job and trigger `Resume`.
2. Choose an active job and trigger `Pause`.
3. Choose any visible job and trigger `Run Now`.
4. Choose a job whose latest actionable run is failed or missed and trigger `Retry`.
5. Confirm each action applies to the correct workspace-scoped job without opening its workspace
   first.
6. Choose any visible job and trigger `Open Workspace`.
7. Confirm the plugin switches to the matching workspace-scoped view and keeps the selected job
   easy to find.

### Verify degraded workspace handling

1. Make one known workspace unavailable or simulate a partially unreadable ledger.
2. Open or refresh the global dashboard.
3. Confirm other readable jobs still appear.
4. Confirm the degraded workspace is still represented with an explicit warning or degraded status.
5. Confirm the dashboard indicates that the user is seeing partial data.

### Verify refresh behavior

1. Leave the dashboard open.
2. Change the state of a job through a workspace action or let a scheduled run complete.
3. Confirm the dashboard updates automatically within 60 seconds.
4. Confirm a manual refresh control is also available and updates the snapshot immediately.

## Validation notes

- The direct global action flow, workspace drilldown, and degraded workspace warnings are part of
  the current implementation.
- No additional quickstart steps were required beyond the scenarios above.
