# Research: Global Job Dashboard

## Decision 1: Build the dashboard as a dedicated plugin tab, not a mode inside workspace views

- **Decision**: Expose the global dashboard as its own top-level plugin tab rather than as a
  workspace/global toggle inside the existing workspace page.
- **Rationale**: The clarification session fixed the entry point as a dedicated global tab. This
  keeps the mental model clear: one surface supervises all workspaces, and the existing workspace
  surfaces remain optimized for local configuration and detailed editing.
- **Alternatives considered**:
  - Reusing the existing workspace tab with a global toggle: rejected because it blurs scope,
    complicates state ownership, and makes routing between global and workspace contexts less clear.
  - Hiding the dashboard behind settings or secondary navigation: rejected because it would weaken
    the primary value of quick operational visibility.

## Decision 2: Aggregate from persisted ledgers, not from host workspace discovery

- **Decision**: Build the global dashboard from the plugin's existing persisted workspace ledgers
  under `HOME`, enumerated server-side on demand.
- **Rationale**: The current plugin already persists the authoritative local state needed for jobs,
  runs, and execution profiles. Reusing those ledgers avoids host-specific workspace discovery
  dependencies and keeps the dashboard available even when some workspaces are not currently open.
- **Alternatives considered**:
  - Querying only currently open workspaces from the host: rejected because it would hide known jobs
    and fail the "all projects" goal.
  - Adding a second global database or index: rejected because it increases migration and
    consistency risk without adding enough value for `v0.2.0`.

## Decision 3: Introduce tolerant aggregation with per-workspace availability states

- **Decision**: The aggregation layer should read each known ledger independently, keep valid
  workspace data visible, and emit explicit availability states for workspaces that are unreadable,
  corrupted, or whose paths no longer resolve cleanly.
- **Rationale**: The spec explicitly requires partial visibility instead of all-or-nothing failure.
  The current `listWorkspaceLedgers()` behavior is strict; `v0.2.0` needs a tolerant read path so a
  single damaged ledger does not blank the whole dashboard.
- **Alternatives considered**:
  - Failing the entire dashboard when any ledger read fails: rejected because it breaks the partial
    data requirement.
  - Silently dropping unreadable workspaces: rejected because it hides operational problems instead
    of surfacing them.

## Decision 4: Reuse existing scheduler actions through cross-workspace routing

- **Decision**: Implement global `Run Now`, `Pause`, `Resume`, and `Retry` by routing to the
  existing scheduler service with an explicit workspace identifier plus task or run identifier.
- **Rationale**: The scheduler already owns lifecycle transitions and execution semantics. Reusing
  it avoids divergent business rules between workspace and global views while keeping `v0.2.0`
  scoped to orchestration rather than rewriting job control logic.
- **Alternatives considered**:
  - Creating separate global-only action handlers: rejected because they would duplicate lifecycle
    rules and increase regression risk.
  - Supporting all existing actions, including edit/delete: rejected by clarified scope because
    structural changes from a global table carry higher UX and safety risk.

## Decision 5: Model retry from the dashboard as "retry latest actionable run"

- **Decision**: The global job record should expose enough information to retry the latest failed or
  missed run for that job directly from the dashboard.
- **Rationale**: The clarification fixed `Retry` as an allowed dashboard action, but retry is
  semantically run-based in `v0.1.0`. The clean bridge is to let the global aggregation surface the
  most recent actionable run identifier alongside the job record so the client can invoke retry
  without loading a per-workspace run history first.
- **Alternatives considered**:
  - Omitting retry from the dashboard despite the clarification: rejected because it would
    contradict the accepted scope.
  - Retrying an arbitrary historical run chosen implicitly: rejected because the behavior would be
    hard to explain and test.

## Decision 6: Use periodic pull refresh, aligned with the existing scheduler cadence

- **Decision**: Refresh the global dashboard automatically on a periodic timer and also support
  explicit manual refresh.
- **Rationale**: The clarification fixed this behavior, and it aligns well with the current server
  scheduler tick model. A periodic pull design is operationally sufficient for `v0.2.0`, easier to
  reason about, and avoids adding a real-time event channel.
- **Alternatives considered**:
  - Manual refresh only: rejected because the clarified UX expects automatic updates.
  - Real-time push updates: rejected because they add protocol and lifecycle complexity without a
    corresponding requirement.

## Decision 7: Preserve the current typed RPC boundary instead of introducing a new transport layer

- **Decision**: Extend the existing HTTP/RPC contract with dedicated global dashboard endpoints and
  typed shared payloads.
- **Rationale**: The plugin already communicates through a typed local HTTP boundary. Extending that
  contract keeps the new feature testable with the current contract and integration suite and avoids
  mixing transport patterns.
- **Alternatives considered**:
  - Direct filesystem access from the frontend: rejected because it breaks plugin boundary safety.
  - An ad hoc one-off global endpoint without shared types: rejected because it would weaken
    contract validation and drift from the established architecture.
