/**
 * Headless launch logs — filename parsing and content extraction.
 *
 * Every headless agent run writes its full stdout+stderr to one file in
 * ~/.claude/comms/artifacts/task-launches/. Two producers write there and both name
 * the file with launchLogName() from launch-policy.ts: this plugin's launchSession()
 * and task-dispatcher.py. This module is the READER side.
 *
 * Extracted from server.ts for the ws-guard.ts reason — server.ts listens at import
 * time, so a test importing it boots a real listener.
 */

import { launchLogName } from './launch-policy.ts';

export interface ParsedLaunchLog {
  agent: string;
  /** First 8 characters of the task UUID — NOT a whole task id. */
  taskId8: string;
}

/**
 * The inverse of launchLogName(agent, taskId) -> `<agent>-<task8>.log`.
 *
 * Written against that function rather than as a free-standing guess, and pinned to
 * it by a round-trip test, because a hardcoded regex here would drift silently from
 * the producer and the section would simply stop listing runs.
 *
 * The agent segment is greedy and the task segment is a fixed 8 hex chars anchored to
 * `.log`, so the split is unambiguous even if an agent name ever contains a hyphen.
 * Task ids are uuid4, so their first 8 characters are always lowercase hex.
 *
 * Returns null for anything that does not match. Callers must SKIP those rather than
 * guessing at an agent — two pre-2026-08 orphans in the live directory are named with
 * a bare task UUID and no agent, and a row with an empty agent is worse than no row.
 */
const LAUNCH_LOG_RE = /^([a-z][a-z0-9_-]*)-([0-9a-f]{8})\.log$/;
const RUN_RECORD_RE = /^([a-z][a-z0-9_-]*)-([0-9a-f]{8})\.json$/;

export function parseLaunchLogName(filename: string): ParsedLaunchLog | null {
  const m = LAUNCH_LOG_RE.exec(filename);
  if (!m) return null;
  return { agent: m[1], taskId8: m[2] };
}

/**
 * The same split for a run record. Two regexes rather than one with an alternating
 * suffix, so a caller cannot accidentally accept a `.log` where it wanted a `.json` —
 * the two are listed from one directory and the union is keyed on the shared stem.
 */
export function parseRunRecordName(filename: string): ParsedLaunchLog | null {
  const m = RUN_RECORD_RE.exec(filename);
  if (!m) return null;
  return { agent: m[1], taskId8: m[2] };
}

/** The `<agent>-<task8>` route id for a run, i.e. its filename without `.log`. */
export function runId(agent: string, taskId8: string): string {
  return `${agent}-${taskId8}`;
}

/** Parse a `<agent>-<task8>` route id by reusing the filename parser. */
export function parseRunId(id: string): ParsedLaunchLog | null {
  return parseLaunchLogName(`${id}.log`);
}

/** The filename a run id maps to. Goes through launchLogName so there is one producer. */
export function runIdToFilename(parsed: ParsedLaunchLog): string {
  return launchLogName(parsed.agent, parsed.taskId8);
}

/**
 * First non-empty line of a run's output, collapsed to one line for a list row.
 */
export function firstLine(text: string, maxChars = 200): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t;
  }
  return '';
}

/**
 * Every fenced code block in the log, as the operator's copyable "Commands" list.
 *
 * Deliberately dumb: no inference about which lines are "really" commands, no
 * filtering by language tag, no rewriting. A false positive costs a glance; a false
 * negative costs the operator the thing they came for.
 *
 * UNTERMINATED fences are dropped. A fence with no closing delimiter has no defined
 * end, so we cannot know we hold the whole command — and these strings are offered
 * with a copy button, i.e. built to be pasted into a shell. Half of `rm -rf /a/b
 * --exclude=c` is not a safe thing to hand someone. The full text is rendered in the
 * log pane regardless, so nothing is hidden, only un-copyable.
 */
export function extractFencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of text.split('\n')) {
    const marker = line.trimStart().startsWith('```');
    if (current === null) {
      if (marker) current = [];
      continue;
    }
    if (marker) {
      const body = current.join('\n').trim();
      if (body) blocks.push(body);
      current = null;
      continue;
    }
    current.push(line);
  }

  // current !== null here means EOF arrived inside a fence — dropped, per above.
  return blocks;
}

/** The subset of fs.Stats runTimes needs, so it is testable without a real file. */
export interface RunStat {
  mtimeMs: number;
  birthtimeMs: number;
}

export interface RunTimes {
  started: string;
  ended: string;
  /** null when the start time is unknowable — rendered as unknown, never as zero. */
  duration_s: number | null;
}

/**
 * Wall-clock span of a run, from its file's timestamps.
 *
 * birthtime is trusted ONLY when it precedes mtime. The 26 pre-existing logs were
 * copy-migrated into the launch-log directory on 2026-08-27, and a copy resets
 * birthtime to the copy time while `cp -p` preserves mtime — so for every historical
 * run birthtime is *later* than mtime. Trusting it blindly reports each of them as
 * having started "just now" and run for a negative duration.
 *
 * Some filesystems report birthtime as 0 rather than as unavailable; that is treated
 * the same way.
 */
export function runTimes(st: RunStat): RunTimes {
  const { mtimeMs, birthtimeMs } = st;
  const usable = Number.isFinite(birthtimeMs) && birthtimeMs > 0 && birthtimeMs <= mtimeMs;
  return {
    started: new Date(usable ? birthtimeMs : mtimeMs).toISOString(),
    ended: new Date(mtimeMs).toISOString(),
    duration_s: usable ? Math.round((mtimeMs - birthtimeMs) / 1000) : null,
  };
}
