import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  callControlApi,
  queueGet,
  tasksQuery,
  apiErrorMessage,
  insecureApiBase,
  LIST_PAGE_MAX,
  type ControlAction,
  type ControlApiOptions,
} from './control-api.ts';
import { loadToken, tokenPath, type TokenResult } from './queue-token.ts';
import { evaluateUpgrade, allowedOrigins } from './ws-guard.ts';
import { resolveAllowedPath } from './path-guard.ts';
import { SharedRead, invalidatingWrite } from './shared-read.ts';
import { WATCH_DEBOUNCE_MS } from './refresh-rules.ts';
import type { DeadLetter, HeadlessRun, HeadlessRunDetail } from './types.ts';
import { toDeadLetter } from './dead-letters.ts';
import { isTerminal } from './vocabulary.ts';
import { preLaunchEnv, launchRefusal } from './launch-guards.ts';
import {
  loadRunRecord,
  outcomeLabel,
  toHeadlessRunView,
  compareRuns,
  type RunRecord,
} from './run-record.ts';
import {
  parseLaunchLogName,
  parseRunId,
  runIdToFilename,
  runId,
  firstLine,
  extractFencedBlocks,
  runTimes,
  parseRunRecordName,
} from './launch-log.ts';
import {
  loadLaunchPolicy,
  policyPath,
  buildLaunchArgv,
  launchLogName,
  runRecordFileName,
  toStartMode,
  START_MODES,
  lookupAgent,
  LaunchPolicyError,
  type LaunchPolicy,
  type StartMode,
} from './launch-policy.ts';

// ── Constants ──────────────────────────────────────────────────────────

const HOME = process.env.HOME ?? os.homedir();
// Watched as a change trigger only (see startWatcher). Nothing in this file parses the
// queue's YAML any more; every read goes through task-queue-mcp's read API.
const TASK_QUEUE_DIR = path.join(HOME, '.claude', 'task-queue');
const START_TIME = Date.now();

// Read from package.json rather than hardcoding. A hardcoded copy silently drifted
// from package.json/manifest.json and shipped a stale version on /health and on the
// WebSocket `connected` event for two releases.
const VERSION: string = (() => {
  try {
    const pkgPath = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

// task-queue-mcp's HTTP API — the single validated path for every queue read and write.
// Mutations inherit the MCP core's transition validation and fcntl locking; reads inherit
// its TTL, dead-letter and status rules. See control-api.ts.
const TASK_QUEUE_API = (process.env.TASK_QUEUE_API ?? 'http://127.0.0.1:8485').replace(/\/$/, '');

// This plugin's own client token, from a fixed file under HOME — never from the env, and
// the path is not configurable through the env either. See queue-token.ts for why.
//
// Loaded at startup and cached once it loads. A failed load is retried on the next
// request, so writing the file (or fixing its mode) takes effect without a CloudCLI
// restart; a token that has loaded is kept until the plugin restarts, which is what
// rotation needs anyway.
const TOKEN_FILE = tokenPath(HOME);
let tokenState: TokenResult | null = null;

function queueToken(): TokenResult {
  if (tokenState?.ok) return tokenState;
  const next = loadToken(TOKEN_FILE);
  // Log a failure once per distinct reason rather than on every request.
  if (!next.ok && (!tokenState || tokenState.ok || tokenState.error !== next.error)) {
    process.stderr.write(`[task-queue] ${next.error} — every queue read and write will fail\n`);
  }
  tokenState = next;
  return next;
}

function apiOpts(): ControlApiOptions {
  return { apiBase: TASK_QUEUE_API, token: queueToken() };
}

/** A read the API refused or could not serve. Carries the status to return to the UI. */
class QueueReadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Agent launch policy — ONE roster, shared with task-dispatcher.py. See
// launch-policy.ts. The hardcoded AGENT_PROJECTS map that used to live here was a
// second copy of the dispatcher's table; it never gained a steward entry, which is
// exactly why Start could not launch steward (vikunja#523). Do not reintroduce it.
//
// Loaded once at startup rather than lazily, so a broken policy is reported when the
// plugin boots instead of on the operator's first Start. It is captured rather than
// thrown, because a throw here would take down the whole plugin — including the
// read-only task list, which needs no policy at all. Every launch then fails with the
// captured error by name; none of them silently falls back to spawning `claude`,
// which for a run-as agent would mean impersonating it.
const LAUNCH_POLICY: { policy: LaunchPolicy | null; error: string | null } = (() => {
  const p = policyPath(process.env, HOME);
  try {
    return { policy: loadLaunchPolicy(p, HOME), error: null };
  } catch (err) {
    const message = err instanceof LaunchPolicyError
      ? err.message
      : `launch policy ${p}: ${(err as Error).message}`;
    process.stderr.write(`[task-queue] launch policy unusable — Start is disabled: ${message}\n`);
    return { policy: null, error: message };
  }
})();

// ── Task reads (task-queue-mcp read API) ──────────────────────────────

// Deliberately looser than the `Task` in types.ts: this is whatever the API returned, so
// every field is optional and unknown keys pass through to the client untouched. The UI
// side gets the strict shape. Only the fields this file actually reads are named.
interface Task {
  id?: string;
  task_type?: string;
  target_agent?: string;
  status?: string;
  summary?: string;
  created?: unknown;
  queue_location?: string;
  /** Passed to the launcher on Start so a `manual-then-auto` task keeps its chain. */
  workflow_mode?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

interface TaskPage {
  tasks: Task[];
  /** How many records matched, which may exceed tasks.length. */
  count: number;
  /** True when the API's page limit cut records off. Rendered, never hidden. */
  truncated: boolean;
}

/**
 * One page of tasks from GET /tasks, at the API's page ceiling.
 *
 * The API applies the queue's own rules: open work is listed however old it is, finished
 * work ages out at its ttl_days, and dead letters are excluded unless asked for. Before
 * v0.11.0 this function globbed the queue directory and applied none of them.
 */
async function listTasks(
  filters: { target_agent?: string; status?: string; task_type?: string; include_dead_letters?: boolean } = {},
): Promise<TaskPage> {
  const result = await queueGet(tasksQuery({ ...filters, limit: LIST_PAGE_MAX }), apiOpts());
  if (result.status !== 200) throw new QueueReadError(502, apiErrorMessage(result));
  const data = result.data as Partial<TaskPage>;
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  const page = {
    tasks,
    count: typeof data.count === 'number' ? data.count : tasks.length,
    truncated: data.truncated === true,
  };
  if (page.truncated) {
    process.stderr.write(
      `[task-queue] task list truncated: ${page.tasks.length} of ${page.count} matching records returned\n`,
    );
  }
  return page;
}

/**
 * The unfiltered list, read once for every caller that asks while a read is in flight.
 *
 * `/tasks` with no filters and `/headless-runs` (through queueIndexByPrefix) both need
 * exactly this read, and the UI requests them together. Filtered lists and the
 * dead-letters read are different queries and are never shared. See shared-read.ts for
 * the rules: nothing is reused once a read settles, and mutate() and the watcher
 * invalidate it.
 */
const unfilteredList = new SharedRead(() => listTasks());

/**
 * Every queue mutation goes through here, never through callControlApi directly.
 *
 * The shared list is invalidated once the mutation returns and before the route responds,
 * so a list the UI asks for after its click never comes from a read that started before
 * the write, whatever the write's outcome (see invalidatingWrite).
 * A test pins that server.ts has no other callControlApi call site.
 */
async function mutate(
  taskId: string,
  action: ControlAction,
  body: Record<string, unknown>,
): ReturnType<typeof callControlApi> {
  return invalidatingWrite(unfilteredList, () => callControlApi(taskId, action, body, apiOpts()));
}

/** GET /tasks/{id}. Null when no record has the id; throws when the API fails. */
async function getTask(taskId: string): Promise<Task | null> {
  if (!VALID_ID.test(taskId)) return null;
  const result = await queueGet(`/tasks/${encodeURIComponent(taskId)}`, apiOpts());
  // Only a 404 means "no such task". The id was validated above, so a 400 from the API is
  // a disagreement worth seeing, and is surfaced like any other API failure rather than
  // rendered as "task not found".
  if (result.status === 404) return null;
  if (result.status !== 200) throw new QueueReadError(502, apiErrorMessage(result));
  return ((result.data as { task?: Task }).task) ?? null;
}

// ── Dead letters (read-only) ──────────────────────────────────────────

/**
 * Every dead-lettered record, shaped for the UI, plus whether the read was truncated.
 *
 * Read through the API with include_dead_letters. Every dead letter carries status
 * `failed`, so the query filters on it to keep the page small, and the API sorts dead
 * letters first so a page limit cuts live `failed` records before it cuts a dead letter.
 * Records are then kept by `queue_location`, never by status: a `failed` task in the live
 * queue is not a dead letter and has no Requeue.
 *
 * Records with no `id` are skipped rather than rendered: a row we cannot address is a row
 * whose Requeue button could not work, and offering one would be a lie.
 */
async function listDeadLetters(): Promise<{ deadLetters: DeadLetter[]; truncated: boolean }> {
  const page = await listTasks({ status: 'failed', include_dead_letters: true });
  const deadLetters: DeadLetter[] = [];
  for (const t of page.tasks) {
    if (t.queue_location !== 'dead-letters') continue;
    const dl = toDeadLetter(t as Record<string, unknown>);
    if (dl) deadLetters.push(dl);
  }
  return { deadLetters, truncated: page.truncated };
}

// ── Context ref preview ───────────────────────────────────────────────

const PREVIEW_ALLOWED_PREFIXES = [
  path.join(HOME, '.claude', 'comms'),
  path.join(HOME, '.claude', 'task-queue'),
];

function previewFile(filePath: string, lines = 20): string | null {
  // The realpath-then-prefix check lives in path-guard.ts — one copy, shared with the
  // headless-run log reader. See that module for why realpath comes first.
  const resolved = resolveAllowedPath(filePath, PREVIEW_ALLOWED_PREFIXES);
  if (!resolved) return null;
  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    const result = content.split('\n').slice(0, lines).join('\n');
    return result;
  } catch {
    return null;
  }
}

// ── Session launcher ──────────────────────────────────────────────────

const LAUNCH_LOG_DIR = path.join(HOME, '.claude', 'comms', 'artifacts', 'task-launches');

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve an executable on PATH (no external deps). Returns absolute path or null.
function resolveBin(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* not executable here — keep looking */ }
  }
  return null;
}

/** Write a run record beside the launch log. Never throws; a launch is already running. */
function writeRunRecord(record: RunRecord): void {
  try {
    fs.mkdirSync(LAUNCH_LOG_DIR, { recursive: true });
    const target = path.join(LAUNCH_LOG_DIR, runRecordFileName(record.agent, record.task_id));
    // Write-then-rename, and the tmp name carries this process's pid: two producers write
    // this directory (this plugin and the dispatcher), so a bare `.tmp` could collide.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (err) {
    // A missing record undercounts a concurrency slot; a thrown error here would fail a
    // Start whose session is already running, which is strictly worse.
    console.error(`[task-queue] could not write run record for ${record.task_id}: ${(err as Error).message}`);
  }
}

/**
 * Stamp a run as ended with the code its child actually returned.
 *
 * Re-read and re-written rather than held in memory: the dispatcher's reaper may have
 * closed the same record in between, and the file is the shared state. If it did, its
 * `pid-gone` is left alone — a reaper that already gave up on this run has recorded
 * something true, and overwriting it with a code observed later would be tidier and less
 * accurate about what was known when.
 */
function closeRunRecord(
  agent: string,
  taskId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  // Through loadRunRecord, like the list route — one guarded reader, and it is unit
  // tested. This call site had its own inline read until the audit pointed out that a
  // fix with no regression test is one refactor away from being undone, and that this
  // reader is the one that gets forgotten precisely because its content is not surfaced.
  const loaded = loadRunRecord(LAUNCH_LOG_DIR, agent, taskId, PREVIEW_ALLOWED_PREFIXES);
  if (!loaded) return;
  // The path the GUARD approved, not one re-derived here.
  const target = loaded.path;
  try {
    const existing = loaded.record;
    if (existing.ended !== null) return;
    existing.ended = new Date().toISOString();
    // A signalled child has no exit code — `code` is null and `signal` names it. Recorded
    // as the reason rather than coerced to a number, for the same reason the dispatcher
    // refuses to invent a zero: 'killed by SIGKILL' and 'exited 0' are different facts.
    existing.exit_code = code;
    existing.reaped = signal === null ? 'exited' : `signal:${signal}`;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch { /* the record was never written, or is gone — nothing to close */ }
}

/**
 * Leave a trace of a Start in the TASK, not only in the launch directory.
 *
 * A launch that leaves no mark on the task is why a completed steward run sat invisible
 * for four days: the plugin's Start button made no queue mutation at all, so a
 * plugin-started task stayed at `approved` until its agent got as far as claiming it —
 * and a session that died before that left nothing behind anywhere.
 *
 * THE STATUS IS DELIBERATELY UNCHANGED — the call re-asserts the status the task is
 * already in. It is tempting to advance `approved` → `in-progress` here, and it would
 * break every plugin-started session: the agent's own first action is
 * update_task(in-progress), which task-queue-mcp permits only FROM `approved`. Doing it
 * for the agent means its claim is refused as an invalid transition.
 *
 * A same-status move needs `allow_override` plus a note, both of which this passes; the
 * handler appends the history entry and the assignment is a no-op. Best-effort: a
 * failure here is logged and does not fail the Start, because the session is already
 * running by this point and reporting the launch as failed would be the bigger lie.
 */
async function recordStartInQueue(
  taskId: string,
  taskData: Record<string, unknown>,
  mode: StartMode,
): Promise<void> {
  const current = typeof taskData.status === 'string' ? taskData.status : '';
  // Terminal and unknown statuses are refused by the handler anyway; not asking is
  // quieter than asking and logging a rejection on every Start of a closed task.
  if (!current || isTerminal(current)) return;
  const { status, data } = await mutate(taskId, 'status', {
    status: current,
    allow_override: true,
    note: `Session launched from CloudCLI in ${mode} mode`,
  });
  if (status !== 200) {
    console.error(
      `[task-queue] launched ${taskId} but could not record it in the task's history: `
      + `${status} ${JSON.stringify(data)}`,
    );
  }
}

/**
 * `queuedMode` is the task's own `workflow_mode`, passed through to the launcher. It is
 * read from the queue record by the caller and never inferred here — see toWorkflowMode.
 */
function launchSession(
  taskId: string,
  targetAgent: string,
  mode: StartMode,
  queuedMode?: string,
): { ok: boolean; error?: string; note?: string } {
  if (!VALID_ID.test(taskId)) return { ok: false, error: `Invalid task id: ${taskId}` };

  if (!LAUNCH_POLICY.policy) {
    return { ok: false, error: `Launch policy unusable: ${LAUNCH_POLICY.error}` };
  }

  const entry = lookupAgent(LAUNCH_POLICY.policy, targetAgent);
  if (!entry) return { ok: false, error: `Unknown agent: ${targetAgent}` };

  if (!fs.existsSync(entry.projectDir)) {
    return { ok: false, error: `Project dir missing: ${entry.projectDir}` };
  }

  // A run-as agent must go through its launcher; an absent or non-executable launcher
  // is refused by name here rather than surfacing as an opaque sudo failure in the log.
  // It must never degrade to spawning `claude` — for a run-as agent that would be
  // impersonation, which is the whole of vikunja#523.
  if (entry.launcher && !isExecutable(entry.launcher)) {
    return {
      ok: false,
      error: `Launcher missing or not executable for run-as agent '${targetAgent}': `
        + `${entry.launcher} — deploy it with forge-scripts-deploy.sh`,
    };
  }

  // Resolve the binary up front so a missing CLI is a clean 400, not a silent exit.
  // Only a directly-launched agent needs it; a run-as agent's launcher resolves its own.
  let claudeBin = '';
  if (!entry.runAsUser) {
    const resolved = resolveBin('claude');
    if (!resolved) return { ok: false, error: 'claude CLI not found on PATH' };
    claudeBin = resolved;
  }

  const prompt = mode === 'review'
    ? `You have a pending task (id=${taskId}). Read it from task-queue-mcp via get_task. Present a summary of the work entailed. Do NOT begin execution — wait for operator approval.`
    : `You have a pending task (id=${taskId}). Read it from task-queue-mcp via get_task. Claim it (update status to in-progress), then execute the task.`;

  const { argv, note } = buildLaunchArgv(entry, mode, prompt, claudeBin, queuedMode);

  // Refuse a session that cannot possibly authenticate, and say which credential is
  // missing — the same two guards task-dispatcher applies, ported in Phase 5.6. Without
  // them a Start spawns a process that 401s from every scoped-mcp tool, or that
  // short-circuits to "Not logged in" before reading the prompt; from the operator's side
  // both look like an agent that started and did nothing.
  //
  // This ALSO layers /opt/appdata/agents/<agent>/.env into the child env, which the
  // dispatcher has always done and this plugin did not. That is the substance of the fix,
  // not a side effect: the CloudCLI process env has no SCOPED_MCP_BEARER_TOKEN, so
  // directly-launched sessions were genuinely starting without one.
  //
  // Both checks are skipped for a run-as agent, deliberately — see launch-guards.ts.
  const guard = preLaunchEnv(targetAgent, entry.runAsUser, process.env, {
    oauthPath: path.join(os.homedir(), '.claude', '.credentials.json'),
  });
  if (!guard.ok) return { ok: false, error: guard.error };

  // Per-launch log replaces stdio:'ignore' so a failed launch is diagnosable.
  // cwd:projectDir is how Claude Code resolves project config — `--project` is not a valid flag.
  let logFd: number;
  let logPath: string;
  try {
    fs.mkdirSync(LAUNCH_LOG_DIR, { recursive: true });
    logPath = path.join(LAUNCH_LOG_DIR, launchLogName(targetAgent, taskId));
    logFd = fs.openSync(logPath, 'a');
  } catch (err) {
    return { ok: false, error: `Cannot open launch log: ${(err as Error).message}` };
  }

  const runId = randomUUID();
  try {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: entry.projectDir,
      stdio: ['ignore', logFd, logFd],
      detached: true,
      // The run identity, so a Langfuse trace can be joined back to the task that paid
      // for it. Same two names the dispatcher uses; a run-as agent gets them from its
      // launcher's flags instead, because sudo scrubs the environment.
      // guard.env, not process.env: the environment that was CHECKED must be the one
      // that is used, or the guard is checking a different process than it protects.
      env: { ...guard.env, FORGE_RUN_ID: runId, FORGE_TASK_ID: taskId },
    });

    child.on('error', (err) => {
      try { fs.appendFileSync(logPath, `[launch error] ${err.message}\n`); } catch { /* best-effort */ }
    });

    // WRITTEN AFTER spawn, because the record's purpose is to carry a pid. A record
    // written first would have to carry a null one, which every reader treats as a dead
    // run — so the dispatcher's reaper would sweep the task to `failed` moments after
    // the session started successfully.
    writeRunRecord({
      run_id: runId,
      task_id: taskId,
      agent: targetAgent,
      launched_by: 'plugin',
      run_as_user: entry.runAsUser ?? null,
      launcher: entry.launcher ?? null,
      workflow_mode: queuedMode ?? 'unknown',
      started: new Date().toISOString(),
      pid: child.pid ?? null,
      ended: null,
      exit_code: null,
      reaped: null,
      log_path: logPath,
    });

    // THIS PLUGIN CAN DO WHAT THE DISPATCHER CANNOT. It is a long-lived process, so the
    // handle outlives the child and 'exit' still fires after unref() — unref only drops
    // the event-loop reference, and the HTTP server keeps the loop alive regardless. So
    // runs started here carry a REAL exit code, where a dispatcher-launched run can only
    // ever be reaped as `pid-gone`.
    //
    // If CloudCLI restarts before the child ends, this never fires and the record stays
    // open. That is not a leak: the dispatcher's reaper closes it on the next tick, with
    // the honest `pid-gone` and a null code. The two mechanisms are complementary and
    // neither invents an outcome.
    child.on('exit', (code, signal) => {
      closeRunRecord(targetAgent, taskId, code, signal);
    });

    child.unref();
    return note ? { ok: true, note } : { ok: true };
  } catch (err) {
    return { ok: false, error: `spawn failed: ${(err as Error).message}` };
  } finally {
    // The child inherited its own dup of the fd; close our copy.
    try { fs.closeSync(logFd); } catch { /* already gone */ }
  }
}

// ── Headless run reader (read-only) ───────────────────────────────────

// This section READS launch logs and never writes them. Both routes resolve through
// the shared path guard; neither ever treats a route id as a path.
//
// SECURITY[accepted]: these routes make launch logs — raw `claude -p` stdout — reachable
// from a browser, where previously they were readable only over SSH. If an agent ever
// prints a credential into its final message, this surfaces it. Accepted 2026-08-27: the
// audience does not widen. The backend binds 127.0.0.1 on an ephemeral port and is reached
// only through CloudCLI's authenticated plugin RPC proxy, so any caller here is already an
// operator-level principal who can read every task payload, launch sessions as any agent,
// and cancel work. Reading agent stdout is not a step up from that. Note the surface IS
// wider than the pre-existing /tasks/:id preview, which returns 20 lines of only the files
// a task names in context_refs — this returns full text for every log, enumerable. Redaction,
// if ever wanted, belongs on the two PRODUCERS (task-dispatcher.py and launchSession), not
// here: a read-only viewer cannot know what a token looks like in arbitrary prose.
// Audit: 2026-08-27/task-queue-headless-runs-ui-2026-08 (F-01, Low).

const HEADLESS_HEAD_BYTES = 2048;
const HEADLESS_MAX_BYTES = 512 * 1024;

/**
 * Map an 8-char task-id prefix to the live queue task, for the derived status.
 *
 * A log proves a session ran; it does not prove its task closed. When the two
 * disagree that is real signal, not noise — steward-f42d3aeb is a completed run whose
 * task sat at `approved` for four days. Render the disagreement; never infer a status
 * from the log's prose.
 *
 * A prefix collision resolves to `unknown` rather than to an arbitrary one of the two.
 */
async function queueIndexByPrefix(): Promise<Map<string, { status: string; taskId: string }>> {
  const idx = new Map<string, { status: string; taskId: string }>();
  const collided = new Set<string>();
  // A failed read leaves every run's status `unknown`, which is what the view renders for
  // a run it cannot match. It must not fail the whole runs list.
  let tasks: Task[] = [];
  try {
    tasks = (await unfilteredList.get()).tasks;
  } catch (err) {
    process.stderr.write(`[task-queue] headless runs: queue status unavailable: ${(err as Error).message}\n`);
  }
  for (const t of tasks) {
    const id = typeof t.id === 'string' ? t.id : '';
    if (!id) continue;
    const key = id.slice(0, 8);
    if (collided.has(key)) continue;
    if (idx.has(key)) { idx.delete(key); collided.add(key); continue; }
    idx.set(key, { status: typeof t.status === 'string' ? t.status : 'unknown', taskId: id });
  }
  return idx;
}

/** Read at most `bytes` from the head of a file. Never reads a whole log to get one line. */
function readHead(filePath: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf-8');
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Read the run record for a stem, if there is one and it is readable from here.
 *
 * The path guard runs on records exactly as it does on logs. A record is JSON this
 * process parses and copies into an API response, so a symlink planted in the launch
 * directory would otherwise put an arbitrary file's contents in front of the operator.
 */
function readRunRecordFor(agent: string, taskId8: string): RunRecord | null {
  return loadRunRecord(LAUNCH_LOG_DIR, agent, taskId8, PREVIEW_ALLOWED_PREFIXES)?.record ?? null;
}

/**
 * Every `<agent>-<task8>` stem in the launch directory, from EITHER artefact.
 *
 * The union matters in one direction that is not hypothetical: the security-audit
 * launcher writes its record here and its log to ~/.pm2/logs, so keying the list on
 * `.log` files alone would omit the commonest kind of headless session on this host.
 * Listing only `.json` would drop the other 29 the other way — those predate run records.
 */
function launchStems(): Map<string, { agent: string; taskId8: string }> {
  const stems = new Map<string, { agent: string; taskId8: string }>();
  let names: string[];
  try {
    names = fs.readdirSync(LAUNCH_LOG_DIR);
  } catch {
    return stems;   // directory absent is an empty list, not an error
  }
  for (const name of names) {
    // Skip anything matching neither shape rather than guessing at an agent. Two
    // pre-2026-08 orphans are named with a bare task UUID and no agent at all.
    const parsed = parseLaunchLogName(name) ?? parseRunRecordName(name);
    if (!parsed) continue;
    stems.set(runId(parsed.agent, parsed.taskId8), parsed);
  }
  return stems;
}

async function listHeadlessRuns(agentFilter?: string): Promise<HeadlessRun[]> {
  const queue = await queueIndexByPrefix();
  const runs: HeadlessRun[] = [];

  for (const parsed of launchStems().values()) {
    if (agentFilter && parsed.agent !== agentFilter) continue;

    const record = readRunRecordFor(parsed.agent, parsed.taskId8);

    // The guard runs on the LIST route too, not only on the detail route: this loop
    // head-reads every file, so a symlink planted in the log dir would otherwise put
    // the first line of its target into a row.
    const resolved = resolveAllowedPath(
      path.join(LAUNCH_LOG_DIR, launchLogName(parsed.agent, parsed.taskId8)),
      PREVIEW_ALLOWED_PREFIXES,
    );
    let st: fs.Stats | null = null;
    if (resolved) {
      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) st = stat;
      } catch { /* record with no co-located log — the audit launcher's shape */ }
    }
    // A stem with neither a readable log nor a record is nothing to show.
    if (!st && !record) continue;

    // Everything below the read is toHeadlessRunView's, in run-record.ts, so the merge
    // decisions are unit-testable — this function can only be exercised by booting a
    // listener. It does the reading; that does the deciding.
    runs.push(toHeadlessRunView({
      agent: parsed.agent,
      taskId8: parsed.taskId8,
      record,
      fileTimes: st ? runTimes(st) : null,
      logSize: st?.size ?? 0,
      firstLine: st && resolved ? firstLine(readHead(resolved, HEADLESS_HEAD_BYTES)) : '',
      queue: queue.get(parsed.taskId8),
    }));
  }

  runs.sort(compareRuns);
  return runs;
}

async function readHeadlessRun(id: string): Promise<HeadlessRunDetail | null> {
  // `id` is validated as <agent>-<task8> and the filename is then REBUILT via
  // launchLogName, so the caller's string never reaches the filesystem as a path even
  // before the realpath guard runs. Two independent barriers, deliberately.
  const parsed = parseRunId(id);
  if (!parsed) return null;

  const record = readRunRecordFor(parsed.agent, parsed.taskId8);

  const resolved = resolveAllowedPath(
    path.join(LAUNCH_LOG_DIR, runIdToFilename(parsed)),
    PREVIEW_ALLOWED_PREFIXES,
  );

  let text = '';
  let truncated = false;
  let logReadable = false;
  let fd: number | null = null;
  if (resolved) {
    try {
      const st = fs.statSync(resolved);
      if (st.isFile()) {
        fd = fs.openSync(resolved, 'r');
        // Read one byte past the cap so a file exactly at the cap is not called truncated.
        const buf = Buffer.alloc(HEADLESS_MAX_BYTES + 1);
        const n = fs.readSync(fd, buf, 0, HEADLESS_MAX_BYTES + 1, 0);
        truncated = n > HEADLESS_MAX_BYTES;
        text = buf.subarray(0, Math.min(n, HEADLESS_MAX_BYTES)).toString('utf-8');
        logReadable = true;
      }
    } catch { /* falls through to the record-only rendering below */ }
    finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* already gone */ } }
    }
  }

  // An unreadable log is only a 404 when there is no record either. With a record, the
  // run is a real thing the operator asked about and the honest answer is its metadata
  // plus where the output actually is — the security-audit launcher writes to
  // ~/.pm2/logs, which stays outside the preview allowlist deliberately: that prefix
  // covers every PM2 service log on the host, and adding it would make this endpoint a
  // reader of all of them.
  if (!logReadable && !record) return null;

  const match = (await queueIndexByPrefix()).get(parsed.taskId8);
  return {
    id: runId(parsed.agent, parsed.taskId8),
    agent: parsed.agent,
    task_id8: parsed.taskId8,
    task_id: match?.taskId ?? record?.task_id ?? null,
    status: match?.status ?? 'unknown',
    text,
    commands: extractFencedBlocks(text),
    truncated,
    has_record: record !== null,
    launched_by: record?.launched_by ?? null,
    outcome: record ? outcomeLabel(record) : null,
    exit_code: record?.exit_code ?? null,
    log_path: record?.log_path ?? null,
    log_readable: logReadable,
  };
}

// ── File watcher ──────────────────────────────────────────────────────

let watchDebounce: ReturnType<typeof setTimeout> | null = null;

function startWatcher(broadcast: (msg: object) => void): void {
  // Ensure directory exists
  if (!fs.existsSync(TASK_QUEUE_DIR)) {
    fs.mkdirSync(TASK_QUEUE_DIR, { recursive: true });
  }

  // The watch is on the queue root only, and fs.watch is not recursive on Linux, so a
  // task arriving in dead-letters/ fires nothing. That is acceptable and deliberate: a
  // dead letter is not live work, the section is collapsed by default, and the operator's
  // refresh (or the next queue-root change, since the dispatcher unlinks the original from
  // the root as it dead-letters) reloads it. Do not add a recursive watch for this — it
  // would stream a surface nobody is watching in real time.
  fs.watch(TASK_QUEUE_DIR, { persistent: false }, (_eventType, filename) => {
    if (!filename?.endsWith('.yml')) return;
    // Invalidate on the raw event, not after the debounce: an agent's write has landed,
    // so a read already in flight may predate it. Plugin-initiated writes are covered
    // earlier, by mutate().
    unfilteredList.invalidate();
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => {
      watchDebounce = null;
      // A change trigger and nothing more: the UI re-reads through the API on this event.
      // It used to carry a file count, which the UI never read, and which was one more
      // reader of the queue directory with its own idea of what counts as a task.
      broadcast({ type: 'tasks', changed: filename });
    }, WATCH_DEBOUNCE_MS);
  });
}

// ── HTTP + WebSocket server ───────────────────────────────────────────

const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

function broadcast(msg: object): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { /* skip */ }
    }
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', version: VERSION }));
  ws.on('close', () => clients.delete(ws));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  try {
    // Health
    if (pathname === '/health' && req.method === 'GET') {
      res.end(JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - START_TIME) / 1000),
        version: VERSION,
      }));
      return;
    }

    // List tasks
    if (pathname === '/tasks' && req.method === 'GET') {
      const filters: Record<string, string> = {};
      const agent = url.searchParams.get('agent');
      const status = url.searchParams.get('status');
      const taskType = url.searchParams.get('type');
      if (agent) filters.target_agent = agent;
      if (status) filters.status = status;
      if (taskType) filters.task_type = taskType;

      // The UI's own list read has no filters, and shares its upstream read with the
      // concurrent /headless-runs request. A filtered call is its own query.
      const page = Object.keys(filters).length === 0
        ? await unfilteredList.get()
        : await listTasks(filters);
      res.end(JSON.stringify(page));
      return;
    }

    // Get task detail
    const taskMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch && req.method === 'GET') {
      const task = await getTask(taskMatch[1]);
      if (!task) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
      // Get context ref previews
      const previews: Record<string, string | null> = {};
      if (task?.payload?.context_refs && Array.isArray(task.payload.context_refs)) {
        for (const ref of task.payload.context_refs as string[]) {
          previews[ref] = previewFile(ref);
        }
      }
      res.end(JSON.stringify({ task, previews }));
      return;
    }

    // List dead letters. Read-only; grouping happens in the panel via groupByReason.
    if (pathname === '/dead-letters' && req.method === 'GET') {
      res.end(JSON.stringify(await listDeadLetters()));
      return;
    }

    // List headless runs. Read-only.
    if (pathname === '/headless-runs' && req.method === 'GET') {
      const agent = url.searchParams.get('agent');
      res.end(JSON.stringify({ runs: await listHeadlessRuns(agent ?? undefined) }));
      return;
    }

    // One headless run's full output. Read-only. The id is matched by the same strict
    // character class as /tasks/:id and is never treated as a path — see readHeadlessRun.
    const runMatch = pathname.match(/^\/headless-runs\/([a-zA-Z0-9_-]+)$/);
    if (runMatch && req.method === 'GET') {
      const run = await readHeadlessRun(runMatch[1]);
      if (!run) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return; }
      res.end(JSON.stringify(run));
      return;
    }

    // Start task
    const startMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/start$/);
    if (startMatch && req.method === 'POST') {
      const body = await readBody(req);
      // Validated, not type-asserted. `as {mode: StartMode}` is a compile-time claim and
      // no runtime check, and this value now reaches a task's persisted history note via
      // recordStartInQueue. An unparseable body is refused here too rather than falling
      // through to the `review` default — the mutation routes below already do this, and
      // a Start is the one route where guessing has a visible consequence.
      let mode: StartMode | null;
      try {
        mode = toStartMode((body ? JSON.parse(body) : {})?.mode);
      } catch {
        mode = null;
      }
      if (mode === null) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          ok: false,
          error: `invalid start mode — expected one of ${START_MODES.join(', ')}`,
        }));
        return;
      }
      const taskData = await getTask(startMatch[1]);
      if (!taskData) { res.statusCode = 404; res.end(JSON.stringify({ error: 'task not found' })); return; }
      const refusal = launchRefusal(taskData);
      if (refusal) {
        res.statusCode = 409;
        res.end(JSON.stringify({ ok: false, error: `not launching: ${refusal}` }));
        return;
      }
      const result = launchSession(
        startMatch[1],
        taskData.target_agent ?? '',
        mode,
        taskData.workflow_mode,
      );
      if (result.ok) await recordStartInQueue(startMatch[1], taskData, mode);
      res.statusCode = result.ok ? 200 : 400;
      res.end(JSON.stringify(result));
      return;
    }

    // Queue mutations — all proxied to the MCP control API (the single validated write
    // path, under this plugin's own token). No direct YAML mutation happens in the plugin.
    const mutationMatch = pathname.match(/^\/tasks\/([a-zA-Z0-9_-]+)\/(approve|cancel|status|park|unpark|amend|requeue)$/);
    if (mutationMatch && req.method === 'POST') {
      const mTaskId = mutationMatch[1];
      const action = mutationMatch[2] as ControlAction;

      let body: Record<string, unknown> = {};
      // status/cancel/park/unpark may carry a note or target status; amend carries the
      // amendment text. approve carries nothing.
      if (action !== 'approve') {
        const raw = await readBody(req);
        let parsed: Record<string, unknown> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
        if (action === 'status') {
          body = {
            status: parsed.status,
            note: parsed.note ?? '',
            allow_override: parsed.allow_override ?? false,
          };
        } else if (action === 'amend') {
          body = { amendment: parsed.amendment ?? '', reason: parsed.reason ?? '' };
        } else {
          // cancel / park / unpark / requeue: an optional note, nothing else.
          if (parsed.note) body.note = parsed.note;
          // unpark may name an explicit status to return to.
          if (action === 'unpark' && parsed.status) body.status = parsed.status;
        }
      }

      const { status: apiStatus, data } = await mutate(mTaskId, action, body);
      res.statusCode = apiStatus;
      res.end(JSON.stringify(data));
      return;
    }

    // 404
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));

  } catch (err) {
    if (err instanceof QueueReadError) {
      // The API's own message (it names a missing token file, a refused token or an
      // unreachable server) is what the operator needs to see. It never carries a token.
      res.statusCode = err.status;
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    process.stderr.write(`[task-queue] ${(err as Error).message}\n`);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'internal server error' }));
  }
});

const MAX_BODY_BYTES = 65536; // 64KB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// WebSocket upgrade — see ws-guard.ts for the rule and why it is shaped this way.
server.on('upgrade', (req, socket, head) => {
  const decision = evaluateUpgrade(
    req.socket.remoteAddress,
    req.headers.origin,
    allowedOrigins(),
  );

  if (!decision.allow) {
    // Log the reason. v0.4.0 refused every connect for three weeks and the only signal
    // was a 403 on the far side of the proxy, naming neither leg nor the cause.
    process.stderr.write(`[task-queue] ws upgrade refused — ${decision.reason}\n`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ── Start ─────────────────────────────────────────────────────────────

server.listen(0, '127.0.0.1', () => {
  const addr = server.address() as { port: number };
  console.log(JSON.stringify({ ready: true, port: addr.port }));
  // Report a refused TASK_QUEUE_API at boot too; every request would fail on it anyway.
  const insecure = insecureApiBase(TASK_QUEUE_API);
  if (insecure) process.stderr.write(`[task-queue] ${insecure} — every queue read and write will fail\n`);
  // Load (and, if broken, report) the token at boot rather than on the first click.
  if (queueToken().ok) process.stderr.write(`[task-queue] client token loaded from ${TOKEN_FILE}\n`);
  startWatcher(broadcast);
});
