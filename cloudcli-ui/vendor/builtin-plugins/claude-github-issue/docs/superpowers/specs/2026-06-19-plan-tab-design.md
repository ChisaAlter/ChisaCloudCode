# Plan tab — design spec

> Brainstormed 2026-06-19 from `docs/PLAN_TAB_BRIEF.md`. Resolves the brief's 5 open
> questions and defines the build. Branch: `feat/plan-tab`. Do not commit to `main`.

## Goal

Add a second internal tab — **"Plan"** — to the claude-github-issue plugin. It replaces
the task-list role of a hand-written `notes.md`: see which phase the work is in, how far
along, what's ahead; reorder tasks; spot bugs; every task links to its GitHub issue.
Prose (decisions, rationale) stays in repo markdown — the Plan tab is a pure task-list.

## Resolved decisions

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Reorder UI | **Native HTML5 drag-and-drop + ▲/▼ buttons (fallback)** | Drag = nice feel; ▲/▼ = reliable on touch/mobile and for a non-coder owner. Native drag avoids a new lib (@dnd-kit) → no bundle bloat, no classic-JSX risk. |
| 2 | Order store | **`.GitHubBoard/plan.json`** (plain JSON) | Mirrors existing `config.service` pattern. Agent edits it directly. At AI-GM scale (773 issues) the file is ~31 KB worst case — parses in <1 ms. SQLite is overkill (no concurrent writes, hundreds of keys not millions). |
| 3 | How agent updates order/phase | **Agent edits `plan.json` directly + sets milestone via `gh`** | Plugin backend is ephemeral (runs only while claudecodeui mounts the plugin). The skill must not depend on it — same as the existing skill reading `github-sync.json` from disk. |
| 4 | v1 scope | Core (tab + phase-grouped ordered list + reorder + issue-modal link + skill) **+ milestone-bootstrap helper** | AI-GM has **0 milestones** today; phases live only in `notes.md`. Without a bootstrap there is nothing to build the phase view from. |
| 5 | Free-form notes area | **No** | Duplicates `notes.md`'s prose role. Plan tab stays a pure task-list. |

## Source of truth (one truth, split roles)

| Concept | Stored as | Who writes |
|---|---|---|
| Phase | GitHub **Milestone** (e.g. "FAZA L") | agent (`gh`) / bootstrap helper |
| Done / not-done | issue **open/closed** | existing flow |
| Status column | labels `in-progress`/`review`/`blocked` | existing flow |
| Priority / bug | labels `bug`, `P0`..`P5` | agent / user |
| **Order within a phase** | **`plan.json`** (only new persistence) | drag/▲▼ in UI; agent direct edit |

Rationale: GitHub already owns done/phase/status — reusing it avoids a second "done"
truth that drifts. The plugin adds only the one thing GitHub lacks: ordering.

## Architecture & data flow

**`GET /plan?path=`** (read):
1. Read config (`github-sync.json`) → token/owner/repo.
2. `github.service`: fetch issues (existing) **+ fetch milestones** (new).
3. `plan.service`: read `plan.json` → `{ "<issue#>": { order, phase? } }`.
4. Merge: group issues by milestone (= phase). Within a group sort by `plan.json` order;
   issues with no order entry go last, sorted by issue number. Compute per-phase progress
   (closed count / total). Issues with no milestone → a "No phase" group at the bottom.
5. Return phase-grouped ordered structure.

**`PUT /plan/order?path=`** body `{ milestone, order: [issue#, ...] }` (write order):
- `plan.service` writes the new order for that phase into `plan.json`. UI calls this after
  drag/▲▼. Agent achieves the same by editing `plan.json` directly (same file, same schema).

**`PUT /plan/phase?path=`** body `{ issue, milestone }` (assign phase):
- PATCH the issue on GitHub with `{ milestone: <number|null> }`.

**`POST /plan/bootstrap?path=`** body `{ phases: [{ title, issues: [#, ...] }] }` (helper):
- For each phase: create the milestone if missing, then assign the listed issues to it.
- Used once to migrate an existing `notes.md`'s phases into GitHub milestones.

## Components to build

### Backend (`src/backend/`)
- **`plan.service.ts`** (new) — read/write `.GitHubBoard/plan.json`.
  - `readPlan(projectPath): Promise<PlanStore>` — returns `{}` if file missing/corrupt (graceful, like `readConfig` → null).
  - `setOrder(projectPath, milestone, issueNumbers[])` — rewrite order 0..n for a phase.
  - Schema: `interface PlanStore { [issueNumber: string]: { order: number; phase?: string } }`.
- **`github.service.ts`** (extend) — add:
  - `listMilestones(token, owner, repo, state?)`
  - `setIssueMilestone(token, owner, repo, issueNumber, milestoneNumber | null)`
  - `createMilestone(token, owner, repo, title)`
- **`server.ts`** (extend) — add routes `GET /plan`, `PUT /plan/order`, `PUT /plan/phase`,
  `POST /plan/bootstrap`. Follow existing route style: `path` query param required, `{error}`
  on failure, CORS already handled. Update `Access-Control-Allow-Methods` already includes PUT.

### Frontend (`src/frontend/`)
- **`App.tsx`** (extend) — internal tab switcher `[ Issues Board | Plan ]`. State `activeTab`,
  persisted in localStorage (`cgi-active-tab`). Still one claudecodeui tab. Shared config/project
  context; Plan tab only renders when configured.
- **`PlanView.tsx`** (new) — fetches `GET /plan`; renders milestone sections each with a
  progress bar and an ordered list of `PlanCard`s. Reorder via native HTML5 drag-and-drop
  **and** ▲/▼ buttons; on change calls `PUT /plan/order` (optimistic update + refetch on error).
  A "No phase" section at the bottom. Reuses polling pattern from `App.tsx` issues fetch.
- **`PlanCard.tsx`** (new) — compact card: issue number, title, priority dot, `bug` badge,
  ▲/▼ buttons, draggable handle. Click → opens existing `GithubIssueModal`. Modal state is
  lifted to `App.tsx` (single `selectedIssue` shared by both tabs) so opening an issue works
  identically from either tab. Reuses `priorityUtils`, `types.ts`, `styles.css` (`cgi-` prefix).
- **Bootstrap UI** — a small modal/button in the Plan tab to trigger `POST /plan/bootstrap`
  (paste/confirm phase→issues mapping). Minimal; the heavy migration can also be agent-driven.

### Skill (`skill/SKILL.md`)
- Add a **"Plan"** section: the `plan.json` schema, how to read/write order (edit the file
  directly — never rely on the plugin backend), the convention Milestone = phase, and
  `gh issue edit <#> --milestone "FAZA L"` for phase assignment. Mirror the existing
  "read config from disk" pattern.

## Types (`types.ts`, extend)
- `GithubIssue` — add optional `milestone?: { number: number; title: string } | null`.
- New: `interface PlanPhase { title: string; milestoneNumber: number | null; total: number; closed: number; issues: GithubIssue[] }`.
- New: `interface PlanData { phases: PlanPhase[] }`.

## Error handling
- `plan.json` missing/corrupt → treat as empty map (no crash).
- Milestone API 403/404 → surface message in UI; the rest of the Plan view still renders.
- Orphan keys in `plan.json` (issue deleted on GitHub) → ignored at merge time. No cleanup in v1 (YAGNI).
- All new routes return `{error}` on failure, matching existing handlers.

## Build & release (must respect CLAUDE.md)
- `jsxRuntime: 'classic'` unchanged. No new runtime deps (native drag, no @dnd-kit).
- After every change: `npm run build` → commit `dist/frontend.js` + `dist/backend.js`
  together with `src/`. Skipping = RPC 503 in host.
- Backend still prints `{"ready":true,"port":N}` within 10 s.
- Version: new feature → minor bump **v1.0.1 → v1.1.0**. Release after merge to `main` + approval.

## Build order (incremental)
1. Backend: `plan.service.ts` + `github.service` milestone calls + `GET /plan` route. Build, commit.
2. Backend: `PUT /plan/order`, `PUT /plan/phase`, `POST /plan/bootstrap`. Build, commit.
3. Frontend: tab switcher in `App.tsx` + `PlanView.tsx` read-only render (phases + progress + cards → modal). Build, commit.
4. Frontend: reorder (drag + ▲/▼ + persist). Build, commit.
5. Bootstrap UI + skill update. Build, commit.
6. Verify live in claudecodeui. Bump to v1.1.0, merge to `main` (on approval), release.

## Out of scope (v1)
- SQLite store. Free-form notes area. Orphan-key cleanup. Auto-creating phases from a parsed
  `notes.md` file (bootstrap takes an explicit phase→issues mapping, not a markdown parser).

## Work hygiene
- Lives only in `szmidtpiotr/claude-github-issue`. AI-GM repo untouched.
- Branch `feat/plan-tab`. Never commit to `main`; merge only when built + verified + approved.
- File an implementation-record issue per repo conventions after build.
