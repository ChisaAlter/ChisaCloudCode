# Tasks: Global Job Dashboard

**Input**: Design documents from `/specs/002-global-job-dashboard/`
**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Tests are required for this feature because it changes behavior, UI state handling, RPC contracts, cross-workspace action routing, and performance-sensitive aggregation behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this belongs to (e.g. `US1`, `US2`, `US3`)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the plugin codebase and test harness for a second top-level dashboard surface.

- [X] T001 Add global dashboard documentation placeholders and release notes anchors in `README.md` and `specs/002-global-job-dashboard/quickstart.md`
- [X] T002 [P] Extend test file scaffolding for dashboard coverage in `tests/integration/global-dashboard.test.ts` and `tests/unit/dashboard.test.ts`
- [X] T003 [P] Reserve source file entry points for global aggregation and rendering in `src/server/dashboard.ts` and `src/client/views/global-dashboard.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the shared types, tolerant storage primitives, and RPC surfaces required by all stories.

**⚠️ CRITICAL**: No user story work should start until this phase is complete.

- [X] T004 Define global dashboard shared types and RPC payloads in `src/shared/model.ts` and `src/shared/contracts.ts`
- [X] T005 [P] Implement tolerant workspace-ledger enumeration and degraded workspace metadata in `src/server/storage.ts`
- [X] T006 [P] Implement server-side dashboard aggregation primitives in `src/server/dashboard.ts`
- [X] T007 Implement global dashboard endpoints and cross-workspace action routing in `src/server/http.ts`
- [X] T008 [P] Implement frontend RPC client helpers for global snapshot and global actions in `src/client/api.ts`
- [X] T009 [P] Extend frontend state to track global snapshot, filters, refresh state, and active tab in `src/client/state.ts`
- [X] T010 Add contract baseline coverage for global dashboard payload schemas in `tests/contract/plugin-rpc.test.ts`
- [X] T011 Add unit coverage for tolerant aggregation and degraded workspace classification in `tests/unit/dashboard.test.ts` and `tests/unit/storage.test.ts`

**Checkpoint**: Foundation ready. User story implementation can begin.

---

## Phase 3: User Story 1 - View global job status (Priority: P1) 🎯 MVP

**Goal**: Let a user open a dedicated global tab and see all known jobs across all persisted workspaces with current status, workspace attribution, recurrence summary, and next run.

**Independent Test**: With multiple persisted workspaces containing jobs, a user can open the dedicated global dashboard tab and see one aggregated list that refreshes automatically and manually without opening any workspace first.

### Tests for User Story 1

- [X] T012 [P] [US1] Extend contract tests for `GET /v1/global-dashboard` snapshot fields in `tests/contract/plugin-rpc.test.ts`
- [X] T013 [P] [US1] Add integration coverage for multi-workspace aggregation and periodic refresh semantics in `tests/integration/global-dashboard.test.ts`
- [X] T014 [P] [US1] Add frontend jsdom coverage for the dedicated global tab, empty state, and aggregated list rendering in `tests/integration/global-dashboard.test.ts`

### Implementation for User Story 1

- [X] T015 [P] [US1] Implement snapshot assembly, workspace labels, and `never_run` derivation in `src/server/dashboard.ts`
- [X] T016 [P] [US1] Build the global dashboard list view with loading, empty, and partial-data shells in `src/client/views/global-dashboard.ts`
- [X] T017 [P] [US1] Add dedicated global-tab layout, refresh timer wiring, and manual refresh control in `src/client/app.ts`
- [X] T018 [US1] Wire global snapshot load, auto-refresh cadence, and tab switching in `src/index.ts`, `src/client/app.ts`, and `src/client/state.ts`

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 4: User Story 2 - Spot operational problems quickly (Priority: P2)

**Goal**: Let a user identify problematic jobs quickly through counters, status filters, urgency ordering, and degraded workspace warnings.

**Independent Test**: With a mix of healthy, paused, failed, missed, never-run, and degraded-workspace jobs, a user can filter the dashboard, see summary counters, and isolate jobs needing action without navigating into workspace views.

### Tests for User Story 2

- [X] T019 [P] [US2] Extend contract tests for summary counters, filters, sort keys, and workspace availability states in `tests/contract/plugin-rpc.test.ts`
- [X] T020 [P] [US2] Add integration coverage for problematic-job classification and partial-data warnings in `tests/integration/global-dashboard.test.ts`
- [X] T021 [P] [US2] Add frontend jsdom coverage for dashboard filters, urgency ordering, and degraded workspace messaging in `tests/integration/global-dashboard.test.ts`

### Implementation for User Story 2

- [X] T022 [P] [US2] Implement summary counter calculation, urgency ordering, and filter application in `src/server/dashboard.ts`
- [X] T023 [P] [US2] Implement degraded workspace warnings and partial-data summary shaping in `src/server/dashboard.ts` and `src/server/storage.ts`
- [X] T024 [P] [US2] Build dashboard summary cards, status filters, and degraded workspace indicators in `src/client/views/global-dashboard.ts`
- [X] T025 [US2] Wire client-side filter state, server query parameters, and problem-job highlighting in `src/client/app.ts`, `src/client/api.ts`, and `src/client/state.ts`

**Checkpoint**: User Stories 1 and 2 both work independently, including degraded workspace visibility and problem-job filtering.

---

## Phase 5: User Story 3 - Act from the global overview (Priority: P3)

**Goal**: Let a user trigger `Run Now`, `Pause`, `Resume`, and `Retry` directly from the global dashboard while preserving correct workspace routing and offering a clear path back to workspace context.

**Independent Test**: From the global dashboard, a user can perform the allowed direct actions on a job from any workspace, observe the result reflected in the dashboard, and still navigate to the original workspace context when needed.

### Tests for User Story 3

- [X] T026 [P] [US3] Extend contract tests for global action endpoints and retry target validation in `tests/contract/plugin-rpc.test.ts`
- [X] T027 [P] [US3] Add integration coverage for cross-workspace `Run Now`, `Pause`, `Resume`, and `Retry` routing in `tests/integration/global-dashboard.test.ts` and `tests/integration/scheduler-loop.test.ts`
- [X] T028 [P] [US3] Add frontend jsdom coverage for global action buttons, optimistic refresh, and workspace drilldown affordances in `tests/integration/global-dashboard.test.ts`

### Implementation for User Story 3

- [X] T029 [P] [US3] Implement cross-workspace action handlers and latest actionable run resolution in `src/server/dashboard.ts`, `src/server/http.ts`, and `src/server/scheduler.ts`
- [X] T030 [P] [US3] Expose per-job available actions and workspace drilldown metadata in `src/server/dashboard.ts` and `src/shared/model.ts`
- [X] T031 [P] [US3] Build global action controls and workspace navigation affordances in `src/client/views/global-dashboard.ts`
- [X] T032 [US3] Wire global action dispatch, optimistic recovery, and post-action snapshot refresh in `src/client/app.ts`, `src/client/api.ts`, and `src/client/state.ts`

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Finish documentation, performance validation, and release hardening across all stories.

- [X] T033 [P] Add README coverage for the dedicated global dashboard tab, direct actions, and degraded workspace behavior in `README.md`
- [X] T034 [P] Add lightweight performance coverage for loading 100 aggregated jobs in `tests/integration/performance.test.ts` and `tests/integration/global-dashboard.test.ts`
- [X] T035 [P] Add regression coverage for unreadable ledgers and moved workspaces in `tests/unit/dashboard.test.ts` and `tests/integration/global-dashboard.test.ts`
- [X] T036 Validate quickstart flows and record any fixes in `specs/002-global-job-dashboard/quickstart.md`
- [X] T037 Run full test suite, fix residual issues, and confirm build outputs in `package.json` scripts and `dist/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup** has no dependencies.
- **Phase 2: Foundational** depends on Phase 1 and blocks all user stories.
- **Phase 3: User Story 1** depends on Phase 2.
- **Phase 4: User Story 2** depends on Phase 2 and benefits from the global list surface delivered in US1.
- **Phase 5: User Story 3** depends on Phase 2 and reuses both the dashboard view and scheduler primitives.
- **Phase 6: Polish** depends on the user stories you intend to ship.

### User Story Dependencies

- **US1 (P1)**: No dependency on other user stories. This is the MVP slice.
- **US2 (P2)**: Depends on foundational aggregation and the dashboard surface from US1, but remains independently testable once global snapshot rendering exists.
- **US3 (P3)**: Depends on foundational aggregation plus the global surface from US1; it reuses scheduler behavior but should be testable independently from filtering features in US2.

### Within Each User Story

- Tests must be written first and fail before implementation.
- Backend aggregation and contract logic should land before UI wiring that depends on them.
- Shared state updates should be complete before action-heavy UI flows are finalized.
- A story is complete only when its independent test passes.

### Parallel Opportunities

- `T002`–`T003` can run in parallel after `T001`.
- `T005`–`T006` and `T008`–`T011` can run in parallel once setup files exist.
- Within US1, `T015`–`T017` can run in parallel after the foundational phase.
- Within US2, `T022`–`T024` can run in parallel after US1 is stable.
- Within US3, `T029`–`T031` can run in parallel after foundational work completes.
- Polish tasks `T033`–`T035` can run in parallel once the targeted stories are stable.

---

## Parallel Example: User Story 1

```bash
# Launch US1 test tasks in parallel
Task: "T012 [US1] Extend contract tests in tests/contract/plugin-rpc.test.ts"
Task: "T013 [US1] Add integration coverage in tests/integration/global-dashboard.test.ts"
Task: "T014 [US1] Add frontend jsdom coverage in tests/integration/global-dashboard.test.ts"

# Launch US1 implementation tasks in parallel
Task: "T015 [US1] Implement snapshot assembly in src/server/dashboard.ts"
Task: "T016 [US1] Build the global dashboard list view in src/client/views/global-dashboard.ts"
Task: "T017 [US1] Add global-tab layout and refresh timer wiring in src/client/app.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational.
3. Complete Phase 3: User Story 1.
4. Stop and validate that the dedicated global tab can load and refresh a consolidated job inventory independently.

### Incremental Delivery

1. Deliver US1 for global visibility and refresh.
2. Add US2 for problem detection, counters, filters, and degraded workspace visibility.
3. Add US3 for cross-workspace direct actions and drilldown.
4. Finish with cross-cutting hardening, performance validation, and documentation.

### Parallel Team Strategy

1. One developer completes shared contracts and tolerant storage primitives.
2. A second developer can build the server aggregation layer while another builds the client dashboard surface after the foundational files exist.
3. After the foundation is stable:
   - Developer A focuses on US1 global rendering and refresh.
   - Developer B focuses on US2 filters, counters, and degraded workspace semantics.
   - Developer C focuses on US3 direct actions and workspace navigation.

---

## Notes

- All tasks use the required checklist format with IDs, optional `[P]`, and `[US#]` labels where applicable.
- Exact file paths follow the single-project plugin structure defined in [plan.md](./plan.md).
- MVP scope is **User Story 1**.
- Avoid introducing a second persistent store, real-time event channel, or unsupported cross-workspace bulk editing in `v0.2.0`.
