# Quickstart: Scheduled Prompt

## Prerequisites

- Node.js 18+ available for local build and test
- A CloudCLI-compatible host with plugin support
- For automatic execution in local mode:
  - the desired local agent CLI available on `PATH`
  - a command template that can accept the scheduled prompt and run inside the workspace

## Local development

1. Install dependencies:

```bash
npm install
```

2. Build the plugin:

```bash
npm run build
```

3. Run the automated test suite:

```bash
npm test
```

## Install in CloudCLI

1. Open `Settings > Plugins`.
2. Install the plugin repository URL.
3. Enable `Scheduled Prompt`.
4. Confirm the plugin tab loads in both light and dark theme contexts.

## Configure local execution

1. Open the plugin tab in the target workspace.
2. Pick a preset (`Codex`, `Claude Code`, or `Gemini CLI`) or enter a custom command template.
3. Save settings and validate that the execution banner reports `ready`.
4. Confirm the preset note matches the expected prompt transport:
   - `Codex`: prompt on `stdin`
   - `Claude Code`: prompt expanded through `{{prompt}}`
   - `Gemini CLI`: prompt expanded through `{{prompt}}`

## Validate primary flows

### Create a one-time task

1. Open the target workspace.
2. Create a one-time scheduled prompt 5 minutes in the future.
3. Verify the task appears in the active schedule list with the expected next run.

### Create a recurring weekday task

1. Create a recurring task for selected weekdays at a local time.
2. Confirm the recurrence summary is human-readable before save.
3. Save and verify the next run is rendered correctly.

### Verify local execution

1. Trigger `Run now` on a saved task or wait for the next due slot.
2. Confirm a run record enters `running`, then transitions to `succeeded` or `failed`.
3. Confirm the plugin records the outcome summary in history.

### Verify missed-run behavior

1. Disable or invalidate local execution settings before a due occurrence.
2. Allow the scheduled time to pass.
3. Reopen the plugin and confirm the run is recorded as `missed`.
4. If several recurring slots were missed while the plugin was unavailable, confirm each missed
   occurrence appears in history with its own scheduled timestamp.
5. Confirm recurring tasks continue from the next future slot rather than replaying missed
   occurrences automatically.

## Validate unsupported local behavior

1. Configure a missing or invalid local executable.
2. Confirm the schedule-management UI still loads.
3. Confirm the execution banner reports automation as unavailable instead of pretending runs will
   execute automatically.
