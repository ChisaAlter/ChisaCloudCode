# Design brief — "Plan" tab (notes.md role inside the plugin)

> Written from a planning session in the AI-GM project (2026-06-19). This is the
> STARTING brief for a dedicated plugin session. First step in that session:
> run `/brainstorming` against this brief, produce a spec, then build. Do NOT start
> coding before the design is confirmed.

## Goal (in plain language)

Today the plugin shows ONE tab: a GitHub Issues Kanban board (columns from labels).
Add a SECOND internal tab — **"Plan"** — that does what a hand-written `notes.md`
task-list does today, but visually and without a markdown file:

- See **which phase** of the plan we're in, how far along, and **what's ahead** —
  tasks grouped by phase, in order.
- **Reorder tasks** (drag) to set the work order.
- Easily see/select **bugs as fixes-to-do**.
- Every task **links to its GitHub issue** (opens the existing issue modal).
- An agent installing the plugin in a project **knows how to read the Plan and update
  it** (via the bundled skill) — no hand-edited file, no guessing.

This lets a project **retire the task-list role of `notes.md`**; `notes.md` keeps only
design prose (decisions, dependency rationale, mechanics). The reference content model
for "Plan" is exactly AI-GM's `notes.md` (phases A–H/U/S/L, ordered tasks, `[ ]/[x]`).

## Where state lives (key decision — keep ONE source of truth)

GitHub is the source of truth for task STATE; the plugin adds the VIEW + the one thing
GitHub lacks (ordering):

| Concept | Stored as | Who writes |
|---|---|---|
| **Phase** | GitHub **Milestone** (e.g. "FAZA L") — gives a native progress bar | agent assigns (`gh issue edit --milestone` or plugin route) |
| **Done / not-done** | issue **open/closed** (existing board logic) | existing flow |
| **Status column** | labels `in-progress`/`review`/`blocked` (existing) | existing flow |
| **Priority / bug-select** | labels `bug`, `P0`..`P5` | agent / user |
| **Order within a phase** | **plugin-owned store** — the ONLY new persistence | drag in UI; agent via plugin route |

→ "store in a DB not a file" = the plugin's own structured store, written through the
backend API (never a hand-edited markdown). Recommended: `<projectRoot>/.GitHubBoard/plan.json`
keyed by issue number `{ "<issue#>": { "phase": "<milestone>", "order": <int> } }`
(mirrors the existing `config.service` JSON pattern). SQLite is an option but JSON matches
the current plugin and is enough; decide in brainstorm.

**Why GitHub for done/phase, plugin only for order:** avoids a second "done" truth that
drifts from GitHub. The existing board already reads GitHub; Plan reuses it and adds order.

## Plugin contract (must respect — from CLAUDE.md)

- `manifest.json` declares one tab (`slot:"tab"`). The "second tab" is an **internal tab
  switcher inside the plugin's own UI** (`App.tsx`): `[ Issues Board | Plan ]`. The plugin
  still contributes a single claudecodeui tab.
- **`dist/` MUST be committed** — claudecodeui runs the committed bundles. After any code
  change: `npm run build` → commit `dist/frontend.js` + `dist/backend.js`. Skipping this =
  RPC 503 in the host UI.
- Frontend: React 18 + TS, **classic JSX runtime** (do not change — host React conflict).
  Mount API: `api.rpc(method, path, body?)`, `api.context`, `api.onContextChange(cb)`.
- Backend: Node HTTP server, must print `{"ready":true,"port":N}` within 10s. Add routes
  alongside existing `/config`, `/issues`, `/ai-prioritize`.

## Likely components to build (confirm in brainstorm)

**Backend** (`src/backend/`):
- `plan.service.ts` — read/write `.GitHubBoard/plan.json` (phase+order per issue).
- `server.ts` routes: `GET /plan` (merge GitHub issues + milestones + stored order →
  phase-grouped ordered list), `PUT /plan/order` (persist reorder), `PUT /plan/phase`
  (assign milestone). Reuse `github.service.ts` for issue/milestone calls.

**Frontend** (`src/frontend/`):
- Tab switcher in `App.tsx` (`Issues Board` | `Plan`).
- `PlanView.tsx` — milestone sections with progress, ordered cards, **drag-reorder**
  (pick a lib or simple up/down — decide in brainstorm), each card opens the existing
  `GithubIssueModal`.
- Reuse `priorityUtils`, `types.ts`, `styles.css` (`cgi-` prefix).

**Skill** (`skill/SKILL.md`):
- Extend so an installed agent knows: how to read the Plan (`GET /plan` shape), how to
  set order/phase, the convention (Milestone=phase, labels=priority/bug). This is the
  "agent knows what to reference" mechanism (same idea as mass-implement's config/skill).

## Open questions for the brainstorm

1. Drag library vs simple up/down buttons (non-coder owner — reliability > fancy).
2. `plan.json` vs SQLite for the order store.
3. How the agent reorders — dedicated plugin route vs `gh` + a convention.
4. Milestone bootstrap: a one-shot to create Milestones from an existing `notes.md`'s
   phases and assign open issues (migration helper).
5. Does "Plan" need a free-form note area (design prose) or stay pure task-list (prose
   stays in repo markdown)? Lean: pure task-list; prose stays in `notes.md`/`game_mechanics`.

## Work hygiene (so nothing mixes with other projects)

- This work lives ONLY in repo `szmidtpiotr/claude-github-issue` (this folder). The AI-GM
  game repo is separate and untouched.
- Branch: **`feat/plan-tab`** (already created). Never commit straight to `main`; merge to
  `main` only when built + verified + approved.
- After code changes: `npm run build`, commit `dist/`, then push the branch.
- Verify in a running claudecodeui instance (install/reload the plugin, open the Plan tab).

## END-TO-END SCOPE v2 (2026-06-19) — plan-only items + full cutover

Decision (Piotr): build the **complete** system and **switch over** — retire `notes.md`'s
task-list role. The Plan tab must hold BOTH real issues AND planned work that has no issue
yet (e.g. the Multiplayer phase G16–G20, currently only prose in `game_mechanics.md`).

### Phase A — plugin feature: plan-only items
- **plan-only item** = a card in the Plan tab that is NOT a GitHub issue. Stored in the
  plugin order/plan store (`.GitHubBoard/plan.json`): `{ id, phase, title, note, order }`.
  Grouped under its phase (same sections as issue cards), reorderable alongside issues.
- **CRUD in the UI:** add / edit / delete a plan-only item (so Piotr writes planned tasks
  directly in the tab — the "write in UI, agent reads it" loop).
- **Promote to issue:** a button that creates a real GitHub issue from the item (title +
  note → body, assign the phase's Milestone, copy order), then removes the plan-only item.
  After promotion it's a normal issue card. This is how planned → actionable.
- **Skill update:** the bundled skill must teach the agent to (a) READ plan-only items via
  the plugin API, (b) add/update them, (c) promote one to an issue. Same contract style as
  the existing order/phase docs in `skill/SKILL.md`.

### Phase B — migration / cutover (run after Phase A is verified in the live UI)
Source of content = AI-GM repo (`szmidtpiotr/ai-gm`): `notes.md` + `game_mechanics.md`.
1. **Milestones = phases:** create GitHub Milestones for every live/planned phase (L, LB,
   B, S, FAZA 5 Multiplayer, FIX, …). Use the Plan tab's existing **bootstrap** helper.
2. **Existing issues → milestone:** assign open issues to their phase milestone.
3. **Planned-not-issue work → plan-only items:** transcribe the still-relevant planned
   tasks from `notes.md`/`game_mechanics.md` (Multiplayer G16–G20, any other unstarted
   phase tasks) into plan-only items under their phase, in order.
4. **Done history:** already-completed phases stay as archived prose (don't recreate as
   items/issues). Keep in `notes.md` history or move to `docs/archive/` in ai-gm.
5. **`notes.md` → prose only:** strip the task-checklist; keep design decisions, ZAKRES,
   dependency rationale, mechanics narrative. `game_mechanics.md` unchanged (spec).
6. **Verify cutover:** open the Plan tab → every active + planned phase visible, ordered,
   with progress; Multiplayer shows as plan-only items; promoting one creates a real issue.

### Cross-impact — mass-implement (AI-GM) MUST be reconciled
`mass-implement` v2 FAZA mode reads task `[ ]/[x]` sections from `notes.md`. After cutover
those sections are gone. The unified path forward:
- **LIST mode already reads GitHub issues** (via `fix_list.md`/board). That stays the live
  autorunner source.
- Planned work lives as plan-only items → **promote to issue** when ready → appears in LIST
  mode. So FAZA mode (notes.md sections) becomes **redundant** post-cutover.
- Action in the AI-GM repo (separate commit, separate session): update
  `.claude/mass-implement.json` + SKILL to drop/deprecate FAZA-mode reliance on notes.md;
  LIST mode (issues) is the single autorunner source. Do NOT silently break FAZA mode —
  update its docs and the config in the same change.
- Update AI-GM `STATUS.md` / `KOMENDY.md` to point at the Plan tab as the task home.

> The plugin build (Phase A) ships from THIS repo on `feat/plan-tab`. The AI-GM-side
> changes (migration content lives in ai-gm; mass-implement/STATUS/KOMENDY edits) are a
> SEPARATE commit in the `szmidtpiotr/ai-gm` repo — never mix the two repos in one commit.

## Process

1. `/brainstorming` against this brief → confirm decisions (open questions above + the
   plan-only item shape, promote flow, store location) → spec.
2. Build incrementally: (Phase A) backend store + routes → UI plan-only CRUD → drag →
   promote-to-issue → skill update. Commit `dist/` each step. Verify live in claudecodeui.
3. (Phase B) migration: bootstrap milestones, assign issues, transcribe planned items,
   slim notes.md, reconcile mass-implement — verify the cutover in the UI.
4. File an implementation-record issue per the plugin repo's conventions.
