# Changelog

All notable changes to this project will be documented in this file.

## [0.12.0] - 2026-09-30

Fewer, parallel reads per refresh. Programme `task-queue-read-perf-2026-09` part 3;
vikunja#1003. **Includes 0.11.1's security fix** (redirects never followed on
token-bearing requests), so deploying 0.12.0 supersedes the pending 0.11.1 deploy.
No change to authentication, the token file or the manifest's grants.

### Changed

- **One upstream `GET /tasks` per refresh, down from two.** `/tasks` (unfiltered) and
  `/headless-runs` used to make the same list read each. They now join one in-flight read
  (`shared-read.ts`). Only the read is shared: nothing is served once it settles. Every
  mutation route and a Start's history write invalidate it before responding, and so
  does the queue watcher, so a list requested after a mutation is always read after it.
  Filtered lists and the dead-letters read are not shared.
- **The tab's three reads run in parallel**, and after a button press the list and the
  task detail are re-read in parallel. A failed runs or dead-letters read still never
  blanks the task list. Results apply last-started-wins, so a slow older refresh cannot
  overwrite a newer one.
- **No second refresh after a button press.** The watcher's `tasks` event for the tab's
  own write arrives about a second later and used to trigger another full refresh. It is
  now skipped when a refresh already started after the change it reports. Changes from
  agents and the dispatcher still refresh live.
- **A second click on the same task is ignored while its action is on the wire**, Start
  included (a double click used to be able to launch two sessions). Mutations are never
  sent in parallel or twice. task-queue-mcp's accepted unpark race (F-01) depends on this.

### Measured

Built backend run locally against forge's live task-queue-mcp v0.13.0, via a counting
proxy (park stubbed at the proxy, so the queue was not written). Median of 7:

| | 0.11.1 | 0.12.0 |
|---|---|---|
| Tab load | 0.372 s, 3 upstream reads | 0.250 s, 2 upstream reads |
| Park + refresh | 0.382 s, 4 upstream reads | 0.268 s, 3 upstream reads |
| Watcher refresh after that Park | 3 more reads | skipped (by rule and unit tests; seen in CloudCLI only after deploy) |

The saving comes from the dropped read, not from overlap. task-queue-mcp's list parse is
CPU-bound, so two concurrent reads take as long as two sequential ones (0.229 s vs
0.215 s).

## [0.11.1] - 2026-09-30

Security fix from the `operator-panel-2026-09-p2-queue-read-api` audit (F-01, Medium;
CodeRabbit CR-03 on #13).

### Security

- **Redirects are never followed on token-bearing requests.** `fetch` follows redirects by
  default, and Undici keeps custom headers across the hop, so a redirect from the configured
  `TASK_QUEUE_API` would have delivered `X-Task-Queue-Token` (read + operator-write) to
  whatever origin the `Location` named. `insecureApiBase()` only vets the configured base.
  Every request now goes out with `redirect: 'manual'`, and any 3xx or opaque-redirect
  response is refused as a 502 without reading its body. task-queue-mcp never redirects,
  so there is no behaviour change on forge. A test with two real loopback servers confirms
  the redirect target is never contacted, and fails against v0.11.0.

## [0.11.0] - 2026-09-29

Own client token, and every read through task-queue-mcp's API. Build
`operator-panel-2026-09-p2-queue-read-api`; vikunja#396. **Requires task-queue-mcp
v0.11.0 or later** and a token file (below).

### Changed

- **The plugin authenticates with its own client token**, read from
  `$HOME/.config/cloudcli-plugin-task-queue/token` and sent as `X-Task-Queue-Token`.
  `manifest.json` no longer requests `env:TASK_QUEUE_API_SECRET`, and no replacement
  grant was added. A manifest grant only works if the CloudCLI host holds the value, and
  every Claude session CloudCLI launches inherits the host's environment, so the old
  shared secret sat in every agent session. The host now holds neither the token nor its
  path. Writes are recorded with `channel: cloudcli`.
- **Fails closed** when the token file is missing, empty, not a regular file, or has any
  group or other permission bit. The UI error names the path and the problem; the token
  is never logged. A missing file is re-checked on the next request.
- **Every queue read goes through the API** (`GET /tasks`, `GET /tasks/{id}`). That covers
  the task list, the task detail, the Start route's task lookup, the dead-letters section
  and the headless-run status index. The backend no longer parses queue YAML at all. The
  list now follows the queue owner's rules: finished tasks past their `ttl_days` age out,
  as they do for every agent's `list_tasks`, where this plugin previously showed every
  file in the directory. Task detail now also resolves archived and dead-lettered ids.
- **Truncation is shown.** The API returns at most 1000 records per read. When it cuts
  records off, the header reads `truncated: showing N of M`, and the dead-letters badge
  says the count may be low.
- **Start launches only live, unfinished work.** Task lookup now also resolves archived and
  dead-lettered records, which the old directory scan never saw. `POST /tasks/:id/start`
  refuses any task outside the live queue or in a terminal status with a 409 and the reason
  (`launchRefusal` in `launch-guards.ts`), so the launch surface is no wider than before.
- **`TASK_QUEUE_API` must be `https://`, or `http://` to a loopback host.** The token goes
  on every read and write, so the plugin refuses to send it in cleartext to another host
  (each request fails with an error naming the variable). The default passes.
- The `tasks` WebSocket event no longer carries a file `count`, which the UI never read.
  The queue watcher is now a change trigger only.

### Removed

- `TASK_QUEUE_API_SECRET` and the `X-Task-Queue-Secret` header.

### Security

- **js-yaml 4.3.1 → 4.3.2** (GHSA-2883-xcg3-v3hh, high: merge keys with empty sources
  are not bounded by `maxTotalMergeKeys`). The plugin parses one YAML file, the
  operator-owned launch policy, so exposure was low; the production-dependency audit gate
  failed on it.

## [0.10.0] - 2026-08-29

Tracker: vikunja#560. Build plan: agent-workflow-interop-2026-08, Phase 5.5 and 5.6.

### Fixed

- **A trailing slash in `project_dir` resolved differently here than in the dispatcher.**
  Node's `path.normalize` keeps a trailing separator (`/a/b/` → `/a/b/`) where Python's
  `os.path.normpath` strips it (`/a/b/` → `/a/b`). Both sides ACCEPTED the entry, so no
  verdict ever disagreed — only the resolved value did, and that value becomes a spawned
  session's working directory. Found by the new corpus gate on its first run, not by
  review; it is the `.resolve()` divergence in a second costume.

### Added

- **`npm run gate:corpus`** — a second parity gate, in its own CI step. task-dispatcher
  owns `tests/fixtures/launch-policy-corpus.json` (27 accept/reject cases) and this
  plugin fetches it from that repo's `main`, asserting `validateLaunchPolicy()` agrees on
  every case. `launch-policy.ts` carried a comment saying the Python side "must keep
  computing this the same way"; this is that comment as a test.

  **Resolved values are compared, not just verdicts.** A verdict-only comparison would
  have reported the two implementations in agreement throughout both divergences found so
  far. Like `gate:vocabulary` it has no skip-on-no-network path, and it refuses an empty
  corpus rather than reporting a vacuous pass.

  It is a separate step from `gate:vocabulary` because it reads a different upstream —
  one red means "edit `src/vocabulary.ts`", the other means "edit `src/launch-policy.ts`".

- **Pre-launch credential guards (`src/launch-guards.ts`).** A Start of a
  directly-launched agent is now refused, by name, when `SCOPED_MCP_BEARER_TOKEN` is
  unresolved or no usable Anthropic credential is available — the two checks
  task-dispatcher has always made. Previously such a Start spawned a session doomed to
  401 from every scoped-mcp tool, or to short-circuit to "Not logged in" before reading
  the prompt; both present to the operator as an agent that started and did nothing.

  The port includes the dispatcher's `load_agent_env`: `/opt/appdata/agents/<agent>/.env`
  is layered into the child environment, which this plugin never did. That is the
  substance of the fix. Measured on forge: the CloudCLI process env carries
  `CLAUDE_CODE_OAUTH_TOKEN` but no `SCOPED_MCP_BEARER_TOKEN`, so a guard checking only
  `process.env` would have refused every non-run-as Start — correctly, in that those
  sessions really were starting without scoped-mcp tools, but that is the bug rather than
  the fix. The environment that is checked is the one the child is spawned with; passing
  `process.env` on to `spawn` after checking a different object would make the guard
  decoration.

  **Both checks are skipped for a `run_as_user` agent, deliberately.** Those credentials
  are not in this process's environment by design — the launcher sources them as the
  target user and makes the equivalent checks itself. Running them here would fail every
  launch for the one agent whose isolation is working correctly.

### Tests

151 → 175. Ten mutants covering every new branch were each confirmed to turn the suite (or
`gate:corpus`) red, including "the run-as short-circuit is removed" and "the run-as path
reads the agent env file it must not touch".

One of them survived the first run: the agent-name traversal test pointed at a path that
did not exist, so `readFileSync` threw and the function returned `{}` whether or not the
name check ran. It asserted the right outcome for the wrong reason. The target file is now
planted, so removing the guard changes the result rather than the route to it.

## [0.9.0] - 2026-08-29

Reads the run records both launchers now write, and makes a Start leave a mark on the task
it started.

Tracker: vikunja#559. Build plan: agent-workflow-interop-2026-08, Phase 3.

### Added

- **A run record beside every launch this plugin starts.**
  `~/.claude/comms/artifacts/task-launches/<agent>-<task8>.json`, the same shape
  `task-dispatcher` v1.3.0 writes. A **sibling** of the log, never a replacement: the
  `.log` name is what this plugin's own reader parses and what the launch-log retention
  job matches on.
- **A real exit code for runs this plugin starts.** It is a long-lived process, so the
  child handle outlives the spawn and `'exit'` still fires after `unref()`. A
  dispatcher-launched run can only ever be reaped as `pid-gone` with a null code; this one
  records what the process actually returned, and a signalled child records the signal
  rather than a coerced number.
- **`FORGE_RUN_ID` / `FORGE_TASK_ID` in the launched session's environment**, so a trace
  can be joined back to the task that paid for it.
- **An outcome column**, with three states kept distinct: `no run record`, `running`,
  and the run's actual outcome — `exit 0`, `exit 137`, `ended, exit code unknown`, or
  `slot released — still running`. `ended, exit code unknown` is the honest rendering of a
  dispatcher launch and is deliberately not collapsed into success.
- **The list is now the union of logs and records.** A record with no co-located log
  renders too — that is the security-audit launcher, whose output goes to `~/.pm2/logs`.
  That prefix stays outside the preview allowlist because it covers every PM2 service log
  on this host, so the detail view says where the log is rather than the row being dropped.
  Dropping it would have omitted the commonest kind of headless session here.
- **Open runs sort above finished ones.** A descending compare on `ended` put them at the
  bottom, under three months of finished runs.

### Fixed

- **A Start made no queue mutation at all.** A plugin-started task stayed at `approved`
  until its agent got as far as claiming it, and a session that died before that left
  nothing behind anywhere — which is why one completed steward run was invisible for four
  days (vikunja#534).

  A Start now appends a history entry through the control API. **The status is
  deliberately unchanged** — the call re-asserts the status the task is already in.
  Advancing `approved` → `in-progress` is the obvious-looking alternative and it breaks
  every plugin-started session: the agent's own first action is
  `update_task(in-progress)`, which task-queue-mcp permits only *from* `approved`.
- **Duration for a still-open run is unknown, not a growing number.** It would otherwise
  be derived from the log's mtime and tick upward on every poll for a session that in fact
  died an hour ago and has not been reaped.

### Changed

- **`src/run-record.ts` added** — the parser for what both launchers write, plus the merge
  that turns (record, log stat, queue match) into one list row. Extracted from `server.ts`
  for the reason every other module here was: `server.ts` listens at import time, so
  nothing inside it can be unit-tested, and the merge is where the decisions are.
- `runRecordFileName` sits beside `launchLogName` in `launch-policy.ts`, pinned to it by a
  round-trip test. If the two stems disagree, one run renders as two rows.

### Security

Both from the audit (`agent-workflow-interop-2026-08-phase34`, 0 Critical/High/Medium,
2 Info). Both fixed rather than accepted.

- **`mode` on `POST /tasks/:id/start` is validated, not type-asserted.** `JSON.parse(body)
  as {mode: StartMode}` is a compile-time claim and no runtime check. Harmless while the
  value only reached `=== 'review'` comparisons that fell through safely — but this
  release gave it a second consumer that writes it into a task's **persisted history
  note**, and a value that lands in a durable record deserves a validator. `toStartMode()`
  now sits beside the type in `launch-policy.ts`, with the closed set exported so the two
  cannot drift.

  An absent mode still defaults to `review`; a present but unrecognised one is a 400.
  Defaulting there would silently downgrade an operator who asked for `auto`, turning a
  typo into a session that quietly does nothing. An unparseable body is refused for the
  same reason.

- **`loadRunRecord()` is now the only way this plugin reads a run record**, extracted into
  `run-record.ts` so the path guard has tests. `closeRunRecord`'s guard was added during
  the pre-audit and had no regression test of its own — `server.ts` calls `listen()` at
  import time, so nothing in it can be unit-tested, which is the same property that let
  the guard be omitted to begin with. The audit's point was that a fix with no test is one
  refactor from being undone.

  It returns the **guard-approved** path alongside the record, so a caller writing the
  record back uses the path realpath approved rather than re-deriving one that was never
  checked. Seven tests, including a real escaping symlink and a non-escaping one.

### Unchanged, deliberately

- **Status still comes from the queue and only from the queue.** A record saying a run
  exited 0 does not promote its task's status. A finished run whose task is still
  `approved` is the disagreement this panel exists to show.
- **The `<agent>-<task8>.log` filename.** Two other consumers key on it.

## [0.8.0] - 2026-08-29

Closes the plugin's task-queue vocabulary drift, then gates it so it cannot silently
reopen. Build `agent-workflow-interop-2026-08` Phase 2; vikunja#558, folding in #543.

### The drift

`task-queue-mcp` made `routing-failed` a first-class non-terminal status and counts it in
`active` on `GET /queue/summary`. The plugin carried four partial hand-written copies of a
vocabulary it does not own, and none of them were updated:

| Site | Effect |
|---|---|
| `panels/task-list.ts` `STATUS_ORDER` | no entry, fell through `?? 9` — a retrying, failing task sorted **below `cancelled`**, dead last |
| `panels/task-list.ts` `NON_TERMINAL_STATUSES` | the status filter never offered the value, and the status-change control could not move a task into it |
| `panels/task-detail.ts` `DETAIL_NON_TERMINAL_STATUSES` | second copy of the same list, stale the same way |
| `panels/styles.ts` `statusColor` | no `case`, so `default: muted` — identical to `parked` and `cancelled`, i.e. "not urgent" |

The status most in need of an operator was the one that sorted last and looked least
urgent. `manual-then-auto` (#543) was the same omission one field over.

### Fixed

- **`routing-failed` is a known status everywhere.** It sorts **above `in-progress`** —
  first in its group — renders in the `error` colour rather than `muted`, is offered by the
  status filter, and is a valid destination in the operator status-change control. Setting
  it by hand is not a dead end: the dispatcher's routing-failed pass picks up any such task
  whose retry window has passed, and a record with no `next_retry_at` is eligible
  immediately, so it reads as "re-route now, skipping re-approval".
- **A `routing-failed` task explains itself.** The detail view gains a banner naming what
  the dispatcher is doing, how many retries are used, when the next attempt is due, and that
  the end of the budget is a dead letter. The status was previously a bare word.
- **An unreadable `next_retry_at` says so.** The `routing-failed` banner interpolated
  `new Date(...).toLocaleString()` directly, so a malformed value in the queue YAML rendered
  the literal string `Invalid Date` at the operator. Same failure as the launch-log
  `birthtime` case: a date the code could not read, presented as though it could. Caught by
  this build's own pre-audit baseline, not by the audit.
- **A queued `manual-then-auto` survives the Start button.** `toWorkflowMode` collapsed it
  to `semi-auto`, which re-pins every task the session spawns back to `semi-auto` — the
  exact failure vikunja#533 added the mode to fix (four security→steward return tasks sat
  unactioned for over a week). `review` on such a task now passes `manual-then-auto`
  through; an explicit `auto` Start still overrides. The launch note says which it did.

### Added

- **`src/vocabulary.ts`** — one copy of the queue's statuses, task types and workflow modes,
  plus the UI maps keyed *by* it. `STATUS_ORDER` and `STATUS_COLOR` are `Record<Status, …>`,
  so adding a status without a sort position and a colour is now a `tsc` error rather than a
  silent fallthrough. That is the half the old code lacked: `Record<string, number>` accepts
  anything and covers nothing.
- **`npm run gate:vocabulary`** — fetches `task-queue-mcp`'s `main` and asserts the sets
  match, as its own CI step. Ported from `task-dispatcher`'s `test_task_queue_vocabulary.py`
  (vikunja#324) with both of the properties that make that one work: **no
  skip-on-no-network path** — it exits non-zero if it cannot read the upstream, because a
  check that quietly passes when it could not reach its source of truth is
  indistinguishable from one that verified something — and it tracks `main`, not a pin, so a
  vocabulary change merged upstream turns this repo red. That is the alarm, not a
  malfunction. It also fails rather than reporting a vacuous pass if it parses zero literals.
  Proven to fire before shipping, in both directions and on all four outcomes.
- **A Mode filter and a mode badge.** The list can be filtered by `workflow_mode` and the
  detail view names it with what it means; rows badge `auto` and `manual-then-auto` and stay
  quiet about `semi-auto`, which is 98% of the queue. A task with no recorded mode renders as
  unknown, not as the queue's default — older records predate the field and inventing a value
  the queue never wrote is how this class of bug starts.

### Changed

- The two `NON_TERMINAL_STATUSES` literals are one derived constant
  (`VALID_STATUSES - TERMINAL_STATUSES`, as upstream derives it). Two copies of one list is
  how the second went stale.
- Relative imports now use `.ts`, not `.js`. `node --test` runs the sources directly and
  does not rewrite a `.js` specifier to the `.ts` file beside it, so the panels — which all
  used `.js` — were not importable by a test. The first one that needed to be, was not.

## [0.7.0] - 2026-08-29

Adds a collapsed **Dead letters** section below the task list, and a Requeue button.
Build `agent-workflow-interop-2026-08` Phase 1; vikunja#557. Pairs with
`task-queue-mcp` v0.10.0, which is where the queue-side half lives.

`~/.claude/task-queue/dead-letters/` is written by `task-dispatcher` when a task exhausts
its routing retries. Nothing could show it: the MCP's `get_task` searched the queue root
then `archive/` and answered `not found`, and this plugin globbed the queue root only.
Seventeen tasks accumulated there between 2026-05-29 and 2026-07-25 — every one a security
audit request, all seventeen carrying the identical `failed_reason` (`Invalid or missing
build_name in payload: 'unknown'`) — and the only notice any of them ever got was a single
Matrix message at the moment it was dropped.

This does not fix the bug that produced them; that is vikunja#63/#169.

### Added
- `GET /dead-letters` — read-only, reading `dead-letters/*.yml` directly like every other
  read here. No new `manifest.json` permission and no new env var.
- `panels/dead-letters.ts` — a **collapsed** section, not a tab: the healthy count is zero,
  so a tab would be permanently empty furniture. The heading renders whatever the count is,
  including `none`, and turns red the moment it is not. The count loads on every refresh
  rather than on expand — a number that appears only after the operator opens the section
  is a number nobody sees.
- `dead-letters.ts` — record shaping and reason-grouping as pure functions, unit-tested.
  **Grouped by `failed_reason`**: seventeen records with one identical reason are one bug
  that fired seventeen times, and seventeen sibling rows read as seventeen unrelated
  problems — roughly how they were treated for three months. Largest group first; newest
  failure first within a group.
- **Requeue** button, wired to the new `requeue` control action → `POST /tasks/:id/requeue`
  on the MCP control API (operator-only there). Confirmed before firing, and the
  confirmation says the part that matters: requeueing does **not** fix why the task was
  dropped, so if the cause is still live it will come back.
- A source-level **drift gate** pinning the `ControlAction` union to `server.ts`'s mutation
  route regex. The AGENTS.md invariant said these were "three copies of one contract" and
  nothing checked it: adding an action to the union alone compiles, and the failure mode is
  a button that 404s against the plugin's own backend. Two of the three copies live in this
  repo and are now pinned to each other. Verified to fail in both directions.

### Security
- Audited 2026-08-29 (`agent-workflow-interop-2026-08-phase1`): no findings in this repo.
  The auditor independently confirmed structurally — not just by test — that
  `toDeadLetter()` builds its response from an explicit field allowlist and never
  references `payload`, so `GET /dead-letters` is a strictly narrower surface than the
  existing `GET /tasks`; and that `renderRow()` escapes every interpolated value while
  routing `summary` and `reason` through `textContent`.

### Notes
- A record with no `id` is **skipped**, never rendered — a row that cannot be addressed is
  a row whose Requeue button could not work.
- An unparseable failure timestamp renders as `—`, not as an age. `ago()` maps an invalid
  date to "just now", which on this surface would claim a three-month-old drop happened
  seconds ago.
- `created` arrives from js-yaml as a `Date` for every real record (unquoted YAML
  timestamp), and is serialised rather than string-coerced.
- The queue watcher still watches the queue root only. `fs.watch` is not recursive on
  Linux, so a task arriving in `dead-letters/` fires no event — deliberate: the section is
  collapsed, a dead letter is not live work, and the dispatcher unlinks the original from
  the root as it dead-letters, which does fire.

## [0.6.0] - 2026-08-27

Adds a **Headless runs** section below the task list: a read-only view of agent sessions
that ran with nobody watching. The output already existed — every headless launch writes
its full stdout to `~/.claude/comms/artifacts/task-launches/<agent>-<task8>.log`, and 26
such logs had accumulated with no interface able to show them. `steward-f42d3aeb`
completed on 2026-08-23 and stayed invisible for four days.

### Added
- `GET /headless-runs` and `GET /headless-runs/:id` — read-only, inside the existing
  preview allowlist. No new `manifest.json` permission and no new env var.
- `panels/headless-runs.ts` — scannable rows (agent, task id, status, started, duration,
  first line of output), an agent filter, and a detail view with the full log in
  monospace. Clicking a row opens it; a task's detail view links to its run output.
- **Commands** block in the run detail: every fenced code block scraped out of the log,
  each with a copy button. Deliberately dumb — no inference about which lines are "really"
  commands. Note that *none* of the 26 pre-existing logs contains a fenced block, so this
  surfaces nothing until an agent emits one.
- `path-guard.ts` and `launch-log.ts`, extracted for the reason `ws-guard.ts` was:
  `server.ts` listens at import time, so a test importing it boots a real listener.

### Changed
- `previewFile` now calls the shared `resolveAllowedPath` rather than carrying its own
  copy of the realpath-then-prefix check. One guard, two callers.
- `HeadlessRun`/`HeadlessRunDetail` live in `types.ts` and are imported by `server.ts`, so
  the route's response shape has a single definition across the bundle boundary.

### Security
- The route id is validated as `<agent>-<task8>` and the filename is then *rebuilt* via
  `launchLogName`, so a caller's string never reaches the filesystem as a path — two
  independent barriers ahead of the realpath guard. Traversal, encoded traversal, and
  absolute paths all 404.
- The path guard applies to the **list** route, not only the detail route. The list
  head-reads every file, so without it a symlink planted in the log directory renders the
  first line of its target as a row. Verified both ways against a real symlink to
  `~/.secrets/forge.env`: it leaked with the guard removed, and is refused with it present.
- Log text and scraped commands render via `textContent`, never `innerHTML`. Launch logs
  are agent stdout, which is not trusted markup.
- Unterminated fenced blocks are dropped from `commands`. They sit behind a copy button
  and are meant to be pasted into a shell; half a command is worse than none.
- Security audit 2026-08-27: **PASS**, no Critical/High/Medium. One Low was **accepted** —
  these routes make launch logs (raw agent stdout) reachable from a browser, where they were
  previously readable only over SSH. Accepted because the audience does not widen: the
  backend is loopback-bound and reached only through CloudCLI's authenticated plugin RPC
  proxy, so any caller is already an operator-level principal. The surface *is* wider than
  the pre-existing `/tasks/:id` context-ref preview; redaction, if wanted, belongs on the
  log producers rather than on a read-only viewer. See `SECURITY[accepted]` in `server.ts`.

### Notes
- `birthtime` is trusted only when it precedes `mtime`. The 26 historical logs were
  copy-migrated into the launch-log directory, and a copy resets birthtime while `cp -p`
  preserves mtime — so trusting it verbatim reported every migrated run as starting "just
  now" and lasting a negative number of seconds. Those runs now show an unknown duration
  rather than a wrong one.
- A run's status is derived from the **queue**, not the log. A log proves a session ran,
  not that its task closed; the two disagreeing is the signal, not noise.

## [0.5.0] - 2026-08-27

Requires a launch policy file at `~/scripts/agent-launch.yml` (see README). The Start
button is disabled with a named error if it is missing or malformed — it never falls back
to a built-in roster, because falling back is what this release removes.

### Fixed
- **The live WebSocket, dead since v0.4.0.** v0.4.0 tightened the upgrade guard to reject a
  *missing* `Origin` as well as a wrong one, reasoning that only non-browser clients omit
  it. The one non-browser client here is CloudCLI's own plugin WS proxy, which uses the
  `ws` library — and that sends no `Origin` unless explicitly passed. Every upstream
  handshake was 403'd from 2026-08-02 to 2026-08-27: 2239 `WS proxy error … 403` lines, and
  a tab that read `disconnected` the whole time. The guard now gates on the **peer**
  (loopback only, refused outright otherwise) and applies the `Origin` allowlist only when
  an `Origin` is actually present. A present-but-wrong `Origin` is still refused; the
  loopback bind was always the real boundary. `AGENTS.md` carried the old rule as a project
  invariant and has been rewritten — leaving it would have invited the same regression from
  the next reviewer. New `ws-guard.ts` holds the decision as a pure function, with tests.
- **The five-second full-panel repaint.** Every failed reconnect emitted `_disconnected`,
  which called `render()` — and `render()` does `root.innerHTML = ''`. So the entire panel
  was torn down and rebuilt every 5s while disconnected, losing scroll position and closing
  any open filter dropdown, even though `wsConnected` was already `false`. Connection state
  no longer reaches `render()` at all: it updates the header badge in place, and only on a
  genuine transition.
- **Start could not launch a run-as agent.** `AGENT_PROJECTS` was a second, drifted copy of
  `task-dispatcher.py`'s roster with no `steward` entry, so Start refused it outright. The
  literal is deleted rather than extended: simply adding an entry would have made
  `launchSession()` spawn `claude` as the plugin's own user, bypassing the launcher whose
  entire purpose is that agent's isolation — a session appearing as steward in every log
  and holding none of steward's credentials.

### Added
- **Reconnect backoff** — 5s → 10s → 30s, capped, reset on a successful open. The first
  delay is unchanged, so a transient blip still recovers as fast as before; the widening is
  for outages. A fixed 5s retry is what turned a three-week outage into 2239 identical log
  lines.
- **`launch-policy.ts`** — one roster, read by this plugin and by `task-dispatcher.py`, from
  `~/scripts/agent-launch.yml`. `AGENT_LAUNCH_POLICY` overrides the path. Every field is
  validated against a closed set (agent name shape, `project_dir` under `~/.claude/projects`,
  `run_as_user` matching `agent-*`, `launcher` under `/usr/local/sbin/forge/`) and the whole
  document is rejected on any violation — a partially-honoured roster would silently launch
  some agent the wrong way. A missing or malformed file is a named error, never an empty
  policy.
- An agent carrying `run_as_user` is launched as
  `sudo -n -u <user> <launcher> --workflow-mode <mode> -- <prompt>`, mirroring the
  dispatcher. A launcher that is missing or not executable is refused **by name**; it never
  degrades to spawning `claude`.
- `env:CLOUDCLI_ORIGIN` in `manifest.json` permissions, so the plugin's allowlist can carry
  the same origin the host's proxy sends.
- Tests for the upgrade guard, the reconnect schedule, and the launch policy. The suite grew
  from 12 to 39.

### Changed
- **Launch logs moved** to `~/.claude/comms/artifacts/task-launches/<agent>-<task8>.log`.
  The dispatcher wrote `~/.pm2/logs/agent-launch-<agent>-<task8>.log` and this plugin wrote
  `<taskId>.log` — two destinations for one concept, so nothing could list "the launches".
  Both now write the same shape to the same directory. `~/.claude/comms` is the side both
  can read; `~/.pm2/logs` is not in `PREVIEW_ALLOWED_PREFIXES` and must not be added, since
  that prefix covers every PM2 service log on the host.
- **Start's `review` maps to the queue's `semi-auto`** for run-as agents rather than being
  passed through. `review` is not a value `task-queue-mcp` or `run-steward.sh` accepts —
  passed through, the launcher refuses it by name. Note that for a run-as agent `review` is
  **prompt-enforced only**: `run-steward.sh` sets `--dangerously-skip-permissions` itself and
  accepts no permission mode, so `--permission-mode plan` is not reachable. The toast says so
  rather than implying a tool gate that is not there.
- **Symlink handling in the launch-policy validator is now identical to the dispatcher's**
  (security audit, Low). Neither side resolves symlinks — not in the containment root and
  not in the candidate `project_dir`. The Python side used to `.resolve()` its root while
  this side used a plain join, so with a symlink anywhere on the path the two disagreed
  about the same input. Documented in both files as a rule rather than left as an accident
  of two independent implementations.
- A refused WebSocket upgrade now logs why. v0.4.0's refusals were silent on this side; the
  only signal was a 403 on the far side of the proxy, naming neither leg nor the cause.

## [0.4.0] - 2026-08-02

Requires [task-queue-mcp](https://github.com/TadMSTR/task-queue-mcp) **v0.4.0** — the
park, unpark, and amend routes do not exist on earlier versions.

### Added
- **Park / Unpark** replaces the Quarantine button in both the list and detail views. A
  parked task **stays in the list**, rendered muted and dashed with an `Unpark` button, and
  the detail view carries a banner naming the status it will return to. Because `parked` is
  now a status rather than a directory move, `listTasks()` picks it up with no reader
  change — the payoff of the upstream design.
- **Amend** action in the detail view. Amendments render directly below the description,
  highlighted, headed "read these, the description above is unchanged" — an amendment
  nobody reads is no better than a note in a file somewhere.
- `parked` is always present in the status filter dropdown, not only once something is
  parked, so the new status is discoverable before first use. It sorts below the live
  statuses but above the terminal ones.
- The history timeline now labels non-status actions (`amend`) by action rather than
  repeating the task's status, which read as a redundant transition.
- `AGENTS.md`, `LICENSE` (MIT), `.github/workflows/ci.yml` and `release.yml`, and README
  badges — bringing the repo to Baseline standard. CI pins Node 22, not 20: `npm test`
  runs `node --test` against the `.ts` sources and depends on Node's built-in type
  stripping, so on Node 20 every test fails with `ERR_UNKNOWN_FILE_EXTENSION`. The repo
  had no CI before, so this was never exercised on a clean interpreter. The plugin's
  runtime requirement is unchanged at Node 20+ — `dist/` is bundled plain JS.

### Changed
- README rewritten for a public audience. It now says what the plugin *is* — a UI for
  `task-queue-mcp` — and that the MCP server is a hard requirement, which a reader landing
  on the repo cold previously could not tell at all. Adds a Requirements section, a Mermaid
  architecture diagram showing the reads-direct / writes-proxied asymmetry, Non-goals, and
  a description of the agent-to-project mapping mechanism in place of a specific agent
  roster. Host-specific paths and log locations genericized.
- `ControlAction` is now `approve | cancel | status | park | unpark | amend`.

### Fixed
- **The reported version was stale.** `server.ts` hardcoded `VERSION = '0.2.0'` while
  `package.json` and `manifest.json` said `0.3.0`, so `/health` and the WebSocket
  `connected` event both under-reported by two releases. The version is now read from
  `package.json` at startup, so it cannot drift again.
- **The Quarantine confirm dialog promised a restore that did not exist.** It told the
  operator the task "can be restored" — but no reader ever listed `quarantine/`, there was
  no Restore button anywhere in the UI, and the backend's restore route was unreachable.
  Quarantining was a one-way trip from the only interface that showed the queue. It had
  never bitten anyone only because the feature had never been used.
- **WebSocket origin check could be skipped entirely.** The guard read
  `if (origin && !allowed.includes(origin))`, so a client sending *no* `Origin` header
  bypassed it. Browsers always send one; non-browser clients do not — precisely the case
  the check exists for. A missing origin is now rejected.
- **`previewFile` did not resolve symlinks.** It used `path.resolve`, which normalises
  `..` but follows nothing, so a symlink inside an allowed prefix pointing anywhere on disk
  passed the check. Now `fs.realpathSync` first, and the prefix compare uses the platform
  separator.
- **`npm run build` invoked `tsc` and `esbuild` through bare `npx`.** With devDependencies
  absent, `npx tsc` silently downloads an unrelated package named `tsc` from the registry
  and the typecheck gate is replaced by a stranger's binary — observed live during this
  build. Both now resolve from `node_modules/.bin`.

### Security
- **`js-yaml` 4.2.0 → 4.3.1** (GHSA-52cp-r559-cp3m, high). "YAML merge-key chains can force
  quadratic CPU consumption", on a **production** dependency sitting on the hot path —
  `yamlLoad()` parses every task file on every list and detail request. Real-world
  exploitability here is low, since the YAML is written by trusted local writers rather
  than attacker-controlled, but the fix was in the declared range and non-breaking.
  `npm audit --omit=dev` is now clean and enforced in CI.

## [0.3.0] - 2026-07-23

### Changed
- Repalette to follow CloudCLI's own theme. `themeColors()` now reads CloudCLI's
  CSS custom properties live off the shared document root — `--primary` (accent),
  `--background`, `--card` (surface), `--border`, `--foreground` (text),
  `--muted-foreground` (muted) — instead of the previous hardcoded amber palette.
  The accent is now CloudCLI blue, and the plugin auto-follows any future CloudCLI
  palette change (including light/dark toggle, already re-driven via
  `api.onContextChange`). Per-theme hardcoded fallbacks are used only when a var is
  missing; the `dark` param now just selects the fallback set.
- Status colors (`ok`/`warn`/`error`) stay hardcoded green/amber/red — CloudCLI has
  no semantic status vars and its dark `--destructive` is too low-contrast for text.

## [0.2.0] - 2026-07-20

### Fixed
- Control-API mutations (approve/cancel/status/quarantine/restore) were silently
  dead: the plugin subprocess never received `TASK_QUEUE_API_SECRET` (the host
  launcher strips it), so `callControlApi`'s missing-secret branch returned an
  unlogged 500 and the request never left the process. Declare
  `permissions: ["env:TASK_QUEUE_API", "env:TASK_QUEUE_API_SECRET"]` in the
  manifest so the (updated) claudecodeui launcher passes the secret through to
  this plugin. Requires claudecodeui with the permission-gated env passthrough.

### Changed
- Both previously-silent failure branches in `callControlApi` (missing secret,
  transport unreachable) now log to stderr — captured into
  `~/.pm2/logs/cloudcli-error.log` — including the task id and action. Never the
  secret value.
- Extracted `callControlApi` into `src/control-api.ts` with an injectable `fetch`
  so its auth/transport guards are unit-testable without booting the HTTP server.

### Tests
- First tests for this repo (`node --test`, native TS type-stripping): missing
  secret returns 500 and never attempts fetch; invalid task id returns 400;
  configured secret is sent as `X-Task-Queue-Secret`; transport failure maps to 502.

### Security
- `SECURITY[accepted]`: control-API 502 response surfaces a Node fetch connection
  error (e.g. ECONNREFUSED) to the loopback operator UI — pre-existing, accepted
  alongside the OE-02 precedent.
