/**
 * Run records — the entity that turns a launch from a side effect into a fact.
 *
 * Written by BOTH launchers into ~/.claude/comms/artifacts/task-launches/ as
 * `<agent>-<task8>.json`, a SIBLING of the `<agent>-<task8>.log` each already wrote.
 * The log's name is deliberately untouched: this plugin's own reader parses it, and the
 * launch-log retention job matches on it, so renaming it to make room for a record would
 * have silently stopped both.
 *
 * This module is both the writer (for runs this plugin starts) and the parser. It has no
 * `fs` import beyond what the writer needs and no HTTP, so it is unit-testable without
 * booting server.ts — the ws-guard.ts reason.
 *
 * THE FIELD SET IS A CROSS-REPO CONTRACT with task_dispatcher.cli.write_run_record().
 * There is no gate pinning the two yet; Phase 5 of agent-workflow-interop-2026-08 is
 * where that lands. Until then, parseRunRecord() below treats every field except
 * `task_id` as optional, so a dispatcher that adds one does not make this side refuse
 * the record outright.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAllowedPath } from './path-guard.ts';
import { runRecordFileName } from './launch-policy.ts';

/** What a launcher writes. Nulls are meaningful: see `exit_code`. */
export interface RunRecord {
  run_id: string;
  task_id: string;
  agent: string;
  /** 'dispatcher' | 'dispatcher-audit' | 'plugin' — who started it. */
  launched_by: string;
  run_as_user: string | null;
  launcher: string | null;
  workflow_mode: string;
  started: string;
  pid: number | null;
  /** ISO timestamp, or null while the run is still open. */
  ended: string | null;
  /**
   * NULL IS NOT A MISSING VALUE. For a dispatcher-launched run it is the honest answer:
   * a cron tick spawns a detached child and exits, so the child is reparented and its
   * status is reaped by init — there is no exit code left to read anywhere. `reaped`
   * says which kind of unknown it is. A zero here would report success for something
   * nobody observed succeed.
   *
   * This plugin is a long-lived process and CAN observe its own children exit, so runs
   * it starts do carry a real code.
   */
  exit_code: number | null;
  /** 'pid-gone' | 'max-runtime' | null — set by whoever closed the record. */
  reaped: string | null;
  log_path: string;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Parse a record written by either launcher. Returns null for anything unusable.
 *
 * Tolerant on purpose, and only in one direction: an UNKNOWN field is ignored and a
 * MISSING field degrades to null, but a record with no `task_id` is rejected outright
 * because every consumer here joins on it. The two writers live in different repositories
 * and deploy separately, so a record from a newer dispatcher than this plugin is a
 * routine state, not a corruption — refusing it would blank the panel on exactly the
 * runs the operator most wants to see.
 */
export function parseRunRecord(raw: unknown): RunRecord | null {
  // Array.isArray is intent, not validation: JSON cannot put a `task_id` property on an
  // array, so the check below already rejects every array. Stated explicitly so the shape
  // this accepts is readable, rather than inferred from what happens to fail later.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const taskId = str(r.task_id);
  if (!taskId) return null;
  return {
    run_id: str(r.run_id),
    task_id: taskId,
    agent: str(r.agent),
    launched_by: str(r.launched_by, 'unknown'),
    run_as_user: strOrNull(r.run_as_user),
    launcher: strOrNull(r.launcher),
    workflow_mode: str(r.workflow_mode, 'unknown'),
    started: str(r.started),
    // A pid of 0 or a non-number is not a pid. Left null rather than coerced, so
    // "no pid recorded" and "pid 0" cannot be confused.
    pid: typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : null,
    ended: strOrNull(r.ended),
    exit_code: typeof r.exit_code === 'number' ? r.exit_code : null,
    reaped: strOrNull(r.reaped),
    log_path: str(r.log_path),
  };
}

/** A record and the realpath-resolved path it was read from. */
export interface LoadedRunRecord {
  path: string;
  record: RunRecord;
}

/**
 * Read a run record through the path guard. THE only way this plugin reads one.
 *
 * Extracted here rather than left in server.ts because server.ts calls `listen()` at
 * import time and cannot be unit-tested — which is exactly how one of its two readers
 * came to be missing this guard in the first place. That reader's content is not
 * surfaced anywhere, so nothing failed and nothing was red; it was found by a pre-audit
 * sweep and its fix then had no regression test of its own. Both readers now call this,
 * and this has tests.
 *
 * Returns the resolved path alongside the record so a caller that writes the record back
 * uses the path the guard approved, rather than re-deriving one that was never checked.
 */
export function loadRunRecord(
  dir: string,
  agent: string,
  taskId: string,
  allowedPrefixes: string[],
): LoadedRunRecord | null {
  const resolved = resolveAllowedPath(
    path.join(dir, runRecordFileName(agent, taskId)),
    allowedPrefixes,
  );
  if (!resolved) return null;
  let record: RunRecord | null;
  try {
    record = parseRunRecord(JSON.parse(fs.readFileSync(resolved, 'utf-8')));
  } catch {
    return null;   // absent or corrupt: the caller falls back to the mtime derivation
  }
  return record ? { path: resolved, record } : null;
}

export interface RunSpan {
  started: string;
  ended: string;
  /** null when unknowable OR when the run has not ended. Never rendered as zero. */
  duration_s: number | null;
}

/**
 * The run's span, from the record rather than from file timestamps.
 *
 * `ended: null` means the run is still open, and duration is therefore not yet a
 * quantity — not zero, and not "now minus started", which would tick upward on every
 * poll for a session that in fact died an hour ago and has not been reaped. The list
 * shows the started time for those, and the reaper fills the rest in.
 *
 * Returns null if the record carries no usable start time, so the caller can fall back
 * to the mtime derivation the 29 pre-record logs still depend on.
 */
export function recordSpan(record: RunRecord): RunSpan | null {
  const startMs = Date.parse(record.started);
  if (!Number.isFinite(startMs)) return null;
  const endMs = record.ended === null ? NaN : Date.parse(record.ended);
  if (!Number.isFinite(endMs)) {
    return { started: new Date(startMs).toISOString(), ended: '', duration_s: null };
  }
  return {
    started: new Date(startMs).toISOString(),
    ended: new Date(endMs).toISOString(),
    // A negative span means the two timestamps disagree about ordering; report unknown
    // rather than a negative duration. The same failure the mtime path already guards.
    duration_s: endMs >= startMs ? Math.round((endMs - startMs) / 1000) : null,
  };
}

/**
 * How a finished run ended, in one phrase, or null while it is still open.
 *
 * The three cases are deliberately distinct in the UI. "exit 0" is a real observation;
 * "ended, exit code unknown" is the honest rendering of a dispatcher-launched run; and
 * "still running (over max runtime)" is a run whose slot was released while its process
 * kept going. Collapsing the middle one into "ok" is the whole failure this build is
 * about.
 */
export function outcomeLabel(record: RunRecord): string | null {
  if (record.ended === null) return null;
  if (record.reaped === 'max-runtime') return 'slot released — still running';
  if (record.exit_code === null) return 'ended, exit code unknown';
  return record.exit_code === 0 ? 'exit 0' : `exit ${record.exit_code}`;
}

// ── Assembling a list row ─────────────────────────────────────────────
//
// Extracted from server.ts's listHeadlessRuns for the reason every other module here was
// (ws-guard, path-guard, control-api, dead-letters): server.ts opens a listener at import
// time, so nothing that lives in it can be unit-tested. This is the part with the actual
// decisions in it — which source wins on times, what a missing record means, and what
// gets said when nothing is known — so it is the part that must be testable.

/** What the caller gathered from disk for one `<agent>-<task8>` stem. */
export interface RunSources {
  agent: string;
  taskId8: string;
  /** The parsed run record, or null for the runs that predate them. */
  record: RunRecord | null;
  /** Times derived from the log's mtime/birthtime, or null when no log is readable. */
  fileTimes: RunSpan | null;
  logSize: number;
  firstLine: string;
  /** The live queue task matching the id prefix, if exactly one does. */
  queue?: { status: string; taskId: string };
}

export interface HeadlessRunView {
  id: string;
  agent: string;
  task_id8: string;
  task_id: string | null;
  status: string;
  started: string;
  ended: string;
  duration_s: number | null;
  size: number;
  first_line: string;
  has_record: boolean;
  launched_by: string | null;
  outcome: string | null;
  exit_code: number | null;
  log_readable: boolean;
}

export function toHeadlessRunView(src: RunSources): HeadlessRunView {
  const { record } = src;
  // The record wins on times when it has usable ones: it knows when the PROCESS started,
  // where the log only knows when its file was touched. For the 26 logs copy-migrated on
  // 2026-08-27 those differ by months, which is why runTimes() has to distrust birthtime
  // at all — a record has no such problem and does not need the same defence.
  const times = (record ? recordSpan(record) : null)
    ?? src.fileTimes
    ?? { started: '', ended: '', duration_s: null };
  return {
    id: `${src.agent}-${src.taskId8}`,
    agent: src.agent,
    task_id8: src.taskId8,
    // The record carries the WHOLE task id even when no live queue task matches the
    // prefix — which is what keeps an archived task's run identifiable.
    task_id: src.queue?.taskId ?? record?.task_id ?? null,
    // Status comes from the QUEUE and only from the queue. A run record proves a session
    // ran and how it ended; it does not prove the task closed. steward-f42d3aeb is a
    // completed run whose task sat at `approved` for four days — that disagreement is
    // signal, and inferring status from the record would erase it.
    status: src.queue?.status ?? 'unknown',
    size: src.logSize,
    first_line: src.firstLine,
    has_record: record !== null,
    launched_by: record?.launched_by ?? null,
    outcome: record ? outcomeLabel(record) : null,
    exit_code: record?.exit_code ?? null,
    log_readable: src.fileTimes !== null,
    ...times,
  };
}

/**
 * List order: open runs first, then most recently ended.
 *
 * Open runs have no `ended`, which a plain descending string compare sorts to the BOTTOM
 * — underneath three months of finished ones, which is precisely where an operator will
 * not look for the session that is running right now.
 */
export function compareRuns(a: HeadlessRunView, b: HeadlessRunView): number {
  if (!a.ended !== !b.ended) return a.ended ? 1 : -1;
  return a.ended ? b.ended.localeCompare(a.ended) : b.started.localeCompare(a.started);
}
