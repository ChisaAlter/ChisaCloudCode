# Tasks: Workspace Scheduled Prompts

**Input**: Design documents from `/specs/001-workspace-scheduled-prompts/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Tests are required for this feature because it changes behavior, UI state handling, RPC contracts, and performance-sensitive scheduler behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. `US1`, `US2`, `US3`)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the plugin skeleton and development tooling required by all later work.

- [X] T001 Create plugin manifest and package metadata in `manifest.json` and `package.json`
- [X] T002 [P] Configure TypeScript project build in `tsconfig.json`
- [X] T003 [P] Add plugin icon asset in `icon.svg`
- [X] T004 [P] Create frontend, backend, and shared source folders with placeholder entry files in `src/index.ts`, `src/types.ts`, `src/client/app.ts`, `src/server/http.ts`, and `src/shared/model.ts`
- [X] T005 [P] Configure Vitest test harness for browser and Node coverage in `package.json`, `tsconfig.json`, and `tests/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the shared infrastructure that all user stories depend on.

**⚠️ CRITICAL**: No user story work should start until this phase is complete.

- [X] T006 Define shared domain types and RPC payload types in `src/shared/model.ts` and `src/shared/contracts.ts`
- [X] T007 [P] Implement workspace identity helpers and workspace-path hashing in `src/shared/workspace.ts`
- [X] T008 [P] Implement JSON persistence and workspace ledger loading/saving in `src/server/storage.ts`
- [X] T009 [P] Implement recurrence calculation primitives and next-occurrence resolution in `src/server/recurrence.ts`
- [X] T010 [P] Implement execution settings validation and capability state evaluation in `src/server/settings.ts`
- [X] T011 Implement backend RPC router and request parsing for contract endpoints in `src/server/http.ts`
- [X] T012 Implement scheduler loop foundation, duplicate-occurrence keys, and persisted due-run ledger handling in `src/server/scheduler.ts`
- [X] T013 [P] Implement frontend RPC client helpers and workspace-state fetch wrapper in `src/client/api.ts`
- [X] T014 [P] Implement frontend state container for tasks, runs, capability, and form state in `src/client/state.ts`
- [X] T015 Add contract baseline tests for workspace-state and task payload schemas in `tests/contract/plugin-rpc.test.ts`
- [X] T016 Add unit coverage for workspace hashing, ledger persistence, and recurrence edge cases in `tests/unit/workspace.test.ts`, `tests/unit/storage.test.ts`, and `tests/unit/recurrence.test.ts`

**Checkpoint**: Foundation ready. User story implementation can begin.

---

## Phase 3: User Story 1 - Create a scheduled workspace task (Priority: P1) 🎯 MVP

**Goal**: Let a user create one-time and recurring workspace tasks with validated schedule rules and visible next-run summaries.

**Independent Test**: In a workspace, a user can create valid one-time and recurring tasks, see them appear immediately with human-readable recurrence details, and is blocked from saving invalid schedules.

### Tests for User Story 1

- [X] T017 [P] [US1] Extend contract tests for task creation and task update payload validation in `tests/contract/plugin-rpc.test.ts`
- [X] T018 [P] [US1] Add integration coverage for create-task RPC, schedule preview, and persisted reload in `tests/integration/scheduler-loop.test.ts`
- [X] T019 [P] [US1] Add frontend jsdom test for task form validation, recurrence summary, and save states in `tests/integration/task-form.test.ts`

### Implementation for User Story 1

- [X] T020 [P] [US1] Implement task create/update/delete/duplicate handlers and recurrence summary generation in `src/server/http.ts`
- [X] T021 [P] [US1] Implement schedule-form state, validation rules, and recurrence summary formatting in `src/client/state.ts` and `src/client/app.ts`
- [X] T022 [P] [US1] Build the schedule list UI with empty/loading/success states in `src/client/views/schedule-list.ts`
- [X] T023 [P] [US1] Build the create/edit task form UI for one-time, daily, weekday, weekly, and monthly schedules in `src/client/views/task-form.ts`
- [X] T024 [US1] Wire the frontend module mount/unmount flow and workspace context subscriptions in `src/index.ts` and `src/client/app.ts`
- [X] T025 [US1] Recalculate `nextRunAt` after create/edit/pause/resume mutations in `src/server/scheduler.ts` and `src/server/recurrence.ts`

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 4: User Story 2 - Monitor execution and recover from failure (Priority: P2)

**Goal**: Let a user inspect upcoming runs and history, configure local execution, and see failed or missed runs with clear recovery paths.

**Independent Test**: With a local execution command configured, a due task creates a run record, launches the configured CLI in the workspace, and exposes failed or missed outcomes plus retry affordances without depending on User Story 3 controls.

### Tests for User Story 2

- [X] T026 [P] [US2] Extend contract tests for run-history, retry, and execution-profile endpoints in `tests/contract/plugin-rpc.test.ts`
- [X] T027 [P] [US2] Add integration tests for local command execution, missed-run recording, and no catch-up replay in `tests/integration/execution-adapter.test.ts` and `tests/integration/scheduler-loop.test.ts`
- [X] T028 [P] [US2] Add frontend jsdom test for local execution capability banner and run-history status rendering in `tests/integration/run-history.test.ts`

### Implementation for User Story 2

- [X] T029 [P] [US2] Implement local command execution adapter and process launch mapping in `src/server/execution-adapter.ts`
- [X] T030 [P] [US2] Implement local execution-profile save/load endpoints and capability evaluation in `src/server/http.ts` and `src/server/settings.ts`
- [X] T031 [P] [US2] Implement run-history query, retry action, and outcome summarization in `src/server/http.ts` and `src/server/scheduler.ts`
- [X] T032 [P] [US2] Implement scheduler handling for `running`, `failed`, `missed`, and duplicate-prevention states in `src/server/scheduler.ts`
- [X] T033 [P] [US2] Build execution readiness banner and local command configuration panel in `src/client/views/execution-banner.ts`
- [X] T034 [P] [US2] Build run-history and upcoming-runs UI with recovery actions in `src/client/views/run-history.ts`
- [X] T035 [US2] Wire execution settings, refresh behavior, and manual retry/run-now flows in `src/client/app.ts` and `src/client/api.ts`

**Checkpoint**: User Stories 1 and 2 both work independently, including local execution and visible failure handling.

---

## Phase 5: User Story 3 - Maintain and control existing schedules (Priority: P3)

**Goal**: Let a user pause, resume, duplicate, edit, delete, and manually rerun existing schedules without corrupting task or run state.

**Independent Test**: A user can change task lifecycle state from the schedule list, confirm the task list and next run update correctly, and verify paused or deleted tasks do not execute automatically.

### Tests for User Story 3

- [X] T036 [P] [US3] Extend contract tests for pause, resume, duplicate, delete, and run-now actions in `tests/contract/plugin-rpc.test.ts`
- [X] T037 [P] [US3] Add integration tests for lifecycle transitions and paused-task non-execution in `tests/integration/scheduler-loop.test.ts`
- [X] T038 [P] [US3] Add frontend jsdom test for list actions, confirmation flows, and post-action state refresh in `tests/integration/schedule-actions.test.ts`

### Implementation for User Story 3

- [X] T039 [P] [US3] Implement pause, resume, duplicate, delete, and manual run-now handlers in `src/server/http.ts`
- [X] T040 [P] [US3] Implement scheduler reactions to lifecycle transitions, including in-flight protection and future occurrence recalculation in `src/server/scheduler.ts`
- [X] T041 [P] [US3] Add task action controls, confirmations, and optimistic-state recovery in `src/client/views/schedule-list.ts`
- [X] T042 [P] [US3] Support editing prefilled tasks and lifecycle-driven form resets in `src/client/views/task-form.ts` and `src/client/state.ts`
- [X] T043 [US3] Wire action dispatch and post-mutation reconciliation across task list, run history, and execution banner in `src/client/app.ts`

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finish documentation, performance validation, and release hardening that affect multiple stories.

- [X] T044 [P] Add README usage, installation, and local execution behavior notes in `README.md`
- [X] T045 [P] Add regression tests for monthly overflow policy and multi-missed-run summaries in `tests/unit/recurrence.test.ts` and `tests/integration/scheduler-loop.test.ts`
- [X] T046 [P] Add lightweight performance benchmarks or fixtures for 100 tasks and 500 runs in `tests/integration/performance.test.ts`
- [X] T047 Validate quickstart flows and record any fixes in `specs/001-workspace-scheduled-prompts/quickstart.md`
- [X] T048 Run full test suite, fix residual issues, and confirm build outputs in `package.json` scripts and `dist/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup** has no dependencies.
- **Phase 2: Foundational** depends on Phase 1 and blocks all user stories.
- **Phase 3: User Story 1** depends on Phase 2.
- **Phase 4: User Story 2** depends on Phase 2 and can begin after the foundation is complete, though it benefits from US1 UI and state scaffolding already existing.
- **Phase 5: User Story 3** depends on Phase 2 and reuses task-management surfaces from US1.
- **Phase 6: Polish** depends on the user stories you intend to ship.

### User Story Dependencies

- **US1 (P1)**: No dependency on other user stories. This is the MVP slice.
- **US2 (P2)**: Depends on foundational scheduler/storage pieces but can be tested independently once task creation exists.
- **US3 (P3)**: Depends on foundational pieces and the task list/form surfaces delivered in US1.

### Within Each User Story

- Tests must be written first and fail before implementation.
- Backend contract and domain logic should land before UI wiring that depends on them.
- Shared state updates should be complete before action-heavy UI flows are finalized.
- A story is complete only when its independent test passes.

### Parallel Opportunities

- `T002`–`T005` can run in parallel after `T001`.
- `T007`–`T010` and `T013`–`T016` can run in parallel once setup files exist.
- Within US1, `T020`–`T023` can run in parallel after the foundational phase.
- Within US2, `T029`–`T034` can run in parallel after the foundational phase.
- Within US3, `T039`–`T042` can run in parallel after the foundational phase.
- Polish tasks `T044`–`T046` can run in parallel once the targeted stories are stable.

---

## Parallel Example: User Story 1

```bash
# Launch US1 test tasks in parallel
Task: "T017 [US1] Extend contract tests in tests/contract/plugin-rpc.test.ts"
Task: "T018 [US1] Add integration coverage in tests/integration/scheduler-loop.test.ts"
Task: "T019 [US1] Add frontend jsdom test in tests/integration/task-form.test.ts"

# Launch US1 implementation tasks in parallel
Task: "T020 [US1] Implement task handlers in src/server/http.ts"
Task: "T022 [US1] Build schedule list UI in src/client/views/schedule-list.ts"
Task: "T023 [US1] Build task form UI in src/client/views/task-form.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Stop and validate that a workspace user can create and persist scheduled tasks independently.

### Incremental Delivery

1. Deliver US1 for schedule creation and persistence.
2. Add US2 for local execution visibility, failure handling, and missed-run recovery.
3. Add US3 for lifecycle controls and operational maintenance.
4. Finish with cross-cutting hardening, documentation, and performance validation.

### Parallel Team Strategy

1. One developer completes setup and shared contracts.
2. A second developer can build scheduler/storage internals while another builds frontend state/UI scaffolding after the foundational files exist.
3. After the foundation is stable:
   - Developer A focuses on US1 flows.
   - Developer B focuses on US2 execution adapter and history.
   - Developer C focuses on US3 lifecycle controls.

---

## Notes

- All tasks use the required checklist format with IDs, optional `[P]`, and `[US#]` labels where applicable.
- Exact file paths follow the single-project plugin structure defined in [plan.md](./plan.md).
- MVP scope is **User Story 1**.
- Avoid expanding v1 into cron syntax or undocumented host-chat integrations unless the contracts change first.
