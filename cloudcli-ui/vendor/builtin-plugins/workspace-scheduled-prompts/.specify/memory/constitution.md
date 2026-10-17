<!--
Sync Impact Report
- Version change: initial adoption -> 1.0.0
- Modified principles: template placeholder principles -> Code Quality Is a Release Gate; Tests
  Prove Behavior Before Merge; CloudCLI UX Must Stay Consistent; Performance Budgets Are Explicit;
  Plugin Boundaries Must Be Safe and Observable
- Added sections: Quality, Testing, and UX Standards; Delivery, Review, and Release Gates
- Removed sections: none
- Templates requiring updates: ✅ .specify/templates/plan-template.md; ✅ .specify/templates/spec-template.md;
  ✅ .specify/templates/tasks-template.md
- Deferred items: none
-->
# CloudCLI Cron Constitution
<!-- CloudCLI Cron is a CloudCLI plugin/extension built from the cloudcli-plugin-starter template. -->

## Core Principles

### I. Code Quality Is a Release Gate
Production code MUST be small, typed, and readable. Every change MUST keep responsibilities narrow,
prefer explicit data flow over hidden side effects, and remove obvious duplication instead of adding
new layers of indirection. Public APIs, RPC handlers, and UI components MUST use clear names,
predictable inputs and outputs, and safe error paths. Dead code, speculative abstractions, and
unrelated refactors MUST NOT be introduced in the same change unless they materially reduce risk
for the active work.

### II. Tests Prove Behavior Before Merge
Behavioral changes MUST be covered by automated tests before merge. Bug fixes MUST include a
regression test that fails against the bug and passes after the fix. Logic that runs in the browser,
in the Node server, or across the RPC boundary MUST be tested at the narrowest useful level, and
changes that affect the plugin contract MUST include integration coverage. Tests MUST assert
observable behavior, not implementation trivia, and a feature is not complete until the relevant
tests pass in CI.

### III. CloudCLI UX Must Stay Consistent
User-facing surfaces MUST match CloudCLI's established interaction patterns, language, spacing,
and state handling. Loading, empty, success, and error states MUST be explicit, and the same action
MUST use the same labels and affordances across the plugin. Any new control, chart, table, or status
indicator MUST justify why the existing CloudCLI pattern is insufficient. The plugin UI MUST remain
usable with keyboard navigation, readable at narrow widths, and consistent across light and dark
presentation modes when the host provides them.

### IV. Performance Budgets Are Explicit
Every feature with user-visible rendering, file scanning, or RPC-heavy work MUST define measurable
performance budgets in the plan before implementation begins. The implementation MUST avoid full
rescans on every interaction, unnecessary round trips, and synchronous work that blocks the plugin
host or browser UI. Expensive computation MUST be cached, incremental, deferred, or moved to the
server subprocess where appropriate. Regressions in startup time, refresh latency, or memory usage
MUST be treated as defects.

### V. Plugin Boundaries Must Be Safe and Observable
The plugin MUST respect the CloudCLI host contract: frontend code owns rendering, server code owns
privileged or heavy work, and communication between them MUST be explicit and typed. Failures MUST
degrade gracefully with actionable messages, and logs MUST be sufficient to diagnose integration
issues without exposing secrets or overwhelming the user. New dependencies MUST be justified by a
concrete plugin need and MUST not expand the surface area of failure without a corresponding test
and rollback path.

## Quality, Testing, and UX Standards

- Any change that alters behavior, UI, manifest data, or RPC contracts MUST include automated test
  coverage or a documented exception in the plan.
- Code touched by a change MUST pass the relevant formatter, linter, type checker, and test suites
  before merge.
- User-facing work MUST specify the loading, empty, success, error, and recovery states that the
  implementation will present.
- UI changes MUST preserve CloudCLI terminology, spacing, hierarchy, and interaction patterns unless
  the plan explicitly records a UX exception and rationale.
- Performance-sensitive work MUST document the measured budget, the measurement method, and the
  fallback behavior if the budget is missed.

## Delivery, Review, and Release Gates

- A change is not complete until the implementation, tests, and validation evidence all agree with
  the spec and plan.
- Plans MUST map each user-visible behavior change to one or more automated tests.
- Reviewers MUST block merge if a change omits regression coverage, breaks UX consistency, or leaves
  a performance-sensitive path unmeasured.
- Manifest changes, RPC contract changes, and storage or state-shape changes MUST include a backward
  compatibility note or a migration plan.
- Documentation updates are required whenever setup, usage, permissions, or observable behavior
  changes for plugin users.

## Governance

This constitution overrides conflicting conventions, ad hoc practices, and template defaults.
Amendments require a pull request that explains the motivation, the version bump, the impact on
existing work, and any template updates needed to keep the workflow consistent.

Versioning follows semantic versioning:

- MAJOR for principle removals, redefinitions, or governance changes that break compatibility.
- MINOR for new principles, materially expanded guidance, or new mandatory workflow sections.
- PATCH for wording clarifications, typo fixes, or non-semantic refinements.

Compliance is mandatory for specs, plans, tasks, checklists, reviews, and implementation work. Any
exception must be documented in the relevant artifact and approved before merge.

**Version**: 1.0.0 | **Ratified**: 2026-04-26 | **Last Amended**: 2026-04-26
