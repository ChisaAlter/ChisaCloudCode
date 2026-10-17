# Implementation Plan: Global Job Dashboard

**Branch**: `002-global-job-dashboard` | **Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/002-global-job-dashboard/spec.md`

## Summary

Add a dedicated global dashboard tab to the existing CloudCLI plugin so users can see all known
scheduled jobs across every persisted workspace, identify problematic jobs quickly, and trigger a
limited set of cross-workspace actions (`Run Now`, `Pause`, `Resume`, `Retry`) without opening each
workspace individually. The design reuses the local JSON ledgers and scheduler primitives from
`v0.1.0`, adds a tolerant aggregation layer for partial or unreadable workspaces, and keeps the UI
consistent with the current plugin shell instead of introducing a second plugin or a separate
storage system.

## Technical Context

**Language/Version**: TypeScript 5.x, ES modules, Node.js 18+ runtime for the plugin server  
**Primary Dependencies**: CloudCLI plugin module API, Node built-ins (`http`, `fs`, `path`,
`crypto`, `timers`), native `fetch`, Luxon, Vitest, jsdom  
**Storage**: Existing JSON workspace ledgers under `HOME`, plus in-memory aggregation state built
on demand from those ledgers; no new persistent store  
**Testing**: Vitest unit tests, jsdom frontend tests, integration tests for global aggregation and
cross-workspace actions, contract validation against plugin RPC schemas  
**Target Platform**: CloudCLI plugin tab plus Node subprocess on CloudCLI UI v1.0+ or compatible
local ClaudeCodeUI installs  
**Project Type**: Single TypeScript CloudCLI plugin with browser frontend module and backend
subprocess  
**Performance Goals**: Load and render 100 aggregated jobs across known workspaces in <=2s; refresh
global dashboard data in <=2s; surface job state changes in <=60s via periodic refresh  
**Constraints**: Must preserve existing workspace-scoped behavior, must degrade gracefully when
some ledgers or workspace paths are unreadable, no bulk cross-workspace operations in `v0.2.0`, no
real-time push channel required, UI must remain usable at narrow widths  
**Scale/Scope**: One dedicated global dashboard tab, up to 100 jobs aggregated across up to dozens
of known workspaces, up to 500 retained runs per workspace ledger, direct job actions limited to
`Run Now`, `Pause`, `Resume`, and `Retry`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- Code Quality: PASS. Keep the change localized to typed shared models, one aggregation-focused
  server module, targeted RPC additions, and one new global dashboard view rather than spreading
  cross-workspace logic through unrelated files.
- Test-First Verification: PASS. The plan requires deterministic coverage for global aggregation,
  partial-ledger failure handling, cross-workspace action routing, and dashboard UI filtering and
  refresh behavior.
- CloudCLI UX Consistency: PASS. The dashboard remains inside the existing plugin shell, uses
  explicit loading/empty/error/partial-data states, and preserves current action labels and status
  chips.
- Performance Budgets: PASS. The plan sets explicit budgets for aggregated load/refresh time and
  avoids new background scans beyond enumerating persisted ledgers already owned by the plugin.
- Simplicity and Dependency Discipline: PASS. The design reuses current ledgers, scheduler
  primitives, and DOM rendering patterns, and does not require a database, streaming channel, or
  new runtime dependencies.

## Project Structure

### Documentation (this feature)

```text
specs/002-global-job-dashboard/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── global-dashboard.md
│   └── plugin-rpc.yaml
└── tasks.md
```

### Source Code (repository root)

```text
manifest.json
package.json
tsconfig.json
icon.svg
src/
├── index.ts
├── types.ts
├── shared/
│   ├── contracts.ts
│   ├── model.ts
│   └── workspace.ts
├── client/
│   ├── app.ts
│   ├── state.ts
│   ├── api.ts
│   └── views/
│       ├── execution-banner.ts
│       ├── global-dashboard.ts
│       ├── run-history.ts
│       ├── schedule-list.ts
│       └── task-form.ts
└── server/
    ├── dashboard.ts
    ├── execution-adapter.ts
    ├── http.ts
    ├── recurrence.ts
    ├── scheduler.ts
    ├── settings.ts
    └── storage.ts

tests/
├── contract/
│   └── plugin-rpc.test.ts
├── integration/
│   ├── global-dashboard.test.ts
│   ├── scheduler-loop.test.ts
│   └── execution-adapter.test.ts
└── unit/
    ├── dashboard.test.ts
    ├── recurrence.test.ts
    ├── storage.test.ts
    └── workspace.test.ts
```

**Structure Decision**: Keep the single-project plugin layout from `v0.1.0`, add one server-side
aggregation module (`src/server/dashboard.ts`) plus one client-side dashboard view
(`src/client/views/global-dashboard.ts`), and extend the existing shared contracts instead of
splitting the plugin into a separate global app surface.

## Complexity Tracking

No constitution exceptions are required for this plan.
