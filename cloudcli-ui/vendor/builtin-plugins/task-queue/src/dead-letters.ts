// Dead letters — the queue's failure path, as data.
//
// `~/.claude/task-queue/dead-letters/` is written by task-dispatcher when a task exhausts
// its routing retries. Until task-queue-mcp v0.10.0 nothing could read it, and until this
// release nothing in CloudCLI could show it: seventeen tasks sat there for three months,
// every one a security audit request, all seventeen carrying the same `failed_reason`, and
// the only notice any of them got was one Matrix message at the moment it was dropped.
// (vikunja#557)
//
// The shaping and grouping live here rather than in the panel so they are unit-testable
// without a DOM, and so the reason-grouping rule — the thing that turns seventeen rows
// into one problem — is a pure function with tests rather than a loop inside a renderer.

import type { DeadLetter, DeadLetterGroup } from './types.ts';

/** The `failed_reason` shape task-dispatcher writes. Every field is optional in practice. */
interface RawFailedReason {
  timestamp?: unknown;
  reason?: unknown;
  retry_count?: unknown;
}

interface RawDeadLetter {
  id?: unknown;
  created?: unknown;
  source_agent?: unknown;
  target_agent?: unknown;
  task_type?: unknown;
  summary?: unknown;
  status?: unknown;
  failed_reason?: RawFailedReason;
  [key: string]: unknown;
}

/** Reason shown when the record carries no `failed_reason.reason` at all. */
export const UNKNOWN_REASON = '(no reason recorded)';

function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v;
  // js-yaml parses an unquoted timestamp into a Date, which is how every real record
  // stores `created`. Anything else that is not a string has no useful rendering.
  if (v instanceof Date) return v.toISOString();
  return fallback;
}

/**
 * Shape one parsed dead-letter YAML record for the UI. Returns null when the record has no
 * `id` — a file we cannot address is a file we must not offer a Requeue button for.
 */
export function toDeadLetter(raw: RawDeadLetter): DeadLetter | null {
  const id = str(raw.id);
  if (!id) return null;

  const fr = raw.failed_reason ?? {};
  return {
    id,
    created: str(raw.created),
    source_agent: str(raw.source_agent, 'unknown'),
    target_agent: str(raw.target_agent, 'unknown'),
    task_type: str(raw.task_type, 'unknown'),
    summary: str(raw.summary, '(no summary)'),
    reason: str(fr.reason) || UNKNOWN_REASON,
    failed_at: str(fr.timestamp),
    retry_count: typeof fr.retry_count === 'number' ? fr.retry_count : 0,
  };
}

/**
 * Group dead letters by their failure reason, largest group first.
 *
 * This is the whole point of the section. Seventeen records with one identical
 * `failed_reason` are ONE bug that fired seventeen times, and a flat list of seventeen
 * rows reads as seventeen unrelated problems — which is roughly how they were treated for
 * three months. Within a group the newest failure sorts first; a group with no usable
 * failure timestamp falls back to `created`.
 */
export function groupByReason(letters: DeadLetter[]): DeadLetterGroup[] {
  const groups = new Map<string, DeadLetter[]>();
  for (const dl of letters) {
    const existing = groups.get(dl.reason);
    if (existing) existing.push(dl);
    else groups.set(dl.reason, [dl]);
  }

  const sortKey = (dl: DeadLetter): number => {
    const t = Date.parse(dl.failed_at || dl.created);
    return Number.isNaN(t) ? 0 : t;
  };

  return [...groups.entries()]
    .map(([reason, items]) => ({
      reason,
      count: items.length,
      letters: [...items].sort((a, b) => sortKey(b) - sortKey(a)),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
