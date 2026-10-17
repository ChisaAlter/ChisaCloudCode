/**
 * The task-queue vocabulary, as this plugin understands it.
 *
 * WHY THIS FILE EXISTS (vikunja#558, #543)
 *
 * The plugin does not own this vocabulary — `task-queue-mcp`'s `src/tools/queue.py` does.
 * It carried four hand-written copies of parts of it instead (`STATUS_ORDER` and
 * `NON_TERMINAL_STATUSES` in `panels/task-list.ts`, `DETAIL_NON_TERMINAL_STATUSES` in
 * `panels/task-detail.ts`, the `switch` in `panels/styles.ts`), and every one of them
 * missed `routing-failed` when the MCP made it a first-class non-terminal status. The
 * result: the status most in need of an operator sorted below `cancelled`, rendered in the
 * same grey as `parked`, and was not offered by the status filter. `manual-then-auto` (#543)
 * was the same omission one field over.
 *
 * Two mechanisms keep this from recurring, and they are different in kind:
 *
 *  1. `gates/vocabulary-parity.ts` fetches the MCP's `main` and asserts the sets below
 *     match it. That catches "upstream changed and we did not". It runs in CI as its own
 *     step and has no skip-on-no-network path — see the script's header.
 *
 *  2. The `Record<Status, …>` maps below are typed by the vocabulary itself, so adding a
 *     value to `VALID_STATUSES` without also giving it a sort position and a colour is a
 *     `tsc` error, not a silent fallthrough to `?? 9` and `muted`. That is the half the
 *     old code lacked: `STATUS_ORDER` was `Record<string, number>`, which accepts anything
 *     and covers nothing.
 *
 * The chain is: upstream adds a status -> the parity gate goes red -> you add it here ->
 * the build stays red until it has a position and a colour. Do not loosen either link.
 */

import type { ThemeColors } from './types.ts';

// ── The sets task-queue-mcp owns ─────────────────────────────────────────────
//
// These are compared literally against `src/tools/queue.py` on the MCP's `main`. Keep them
// as flat `as const` arrays of string literals: the gate reads them by importing this
// module, but a human diffing the two files should be able to do it by eye.

export const VALID_STATUSES = [
  'submitted',
  'approved',
  'pending-approval',
  'in-progress',
  'parked',
  'routing-failed',
  'completed',
  'failed',
  'cancelled',
] as const;

export const TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export const VALID_TASK_TYPES = [
  'build',
  'deploy',
  'fix',
  'research',
  'review',
  'audit',
  'notify',
  'docs',
  'ticket_audit',
  'ticket_audit_complete',
] as const;

export const VALID_WORKFLOW_MODES = ['semi-auto', 'auto', 'manual-then-auto'] as const;

export type Status = (typeof VALID_STATUSES)[number];
export type TaskType = (typeof VALID_TASK_TYPES)[number];
export type WorkflowMode = (typeof VALID_WORKFLOW_MODES)[number];

/**
 * Derived, exactly as upstream derives it (`VALID_STATUSES - TERMINAL_STATUSES`). Written
 * as a subtraction rather than a second list because the two hand-written copies this
 * replaces are the whole reason this file exists.
 */
export const NON_TERMINAL_STATUSES: readonly Status[] = VALID_STATUSES.filter(
  (s): s is Status => !(TERMINAL_STATUSES as readonly string[]).includes(s),
);

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

// ── UI mappings, keyed by the vocabulary ─────────────────────────────────────

/**
 * Sort position within an agent group. Lower sorts first.
 *
 * `routing-failed` sorts ABOVE `in-progress`: it is a task the dispatcher could not route
 * and is backing off on, so it is the row most likely to need a human, and under the old
 * `?? 9` fallthrough it sorted below `cancelled` — dead last, beneath work nobody intends
 * to do. Terminal statuses stay at the bottom; `parked` sits between live and terminal
 * because it is paused work, not finished work.
 */
export const STATUS_ORDER: Record<Status, number> = {
  'routing-failed': 0,
  'in-progress': 1,
  'approved': 2,
  'pending-approval': 3,
  'submitted': 4,
  'parked': 5,
  'completed': 6,
  'failed': 7,
  'cancelled': 8,
};

/**
 * Which theme colour each status renders in.
 *
 * `routing-failed` is `error` rather than `warn`. `warn` already carries
 * `pending-approval`, which is a routine state every task passes through; a status that
 * means "the dispatcher gave up on this leg and is counting down to a dead letter" has to
 * outrank it. It shares `error` with `failed`, which is acceptable — they are adjacent in
 * meaning and the label sits next to the dot. What is not acceptable is the `muted` it
 * used to fall through to, which read identically to `cancelled`.
 */
export const STATUS_COLOR: Record<Status, keyof ThemeColors> = {
  'submitted': 'muted',
  'approved': 'ok',
  'pending-approval': 'warn',
  'in-progress': 'accent',
  'parked': 'muted',
  'routing-failed': 'error',
  'completed': 'ok',
  'failed': 'error',
  'cancelled': 'muted',
};

/**
 * How each workflow mode is shown. The distinction that matters is the third one:
 * `manual-then-auto` gates only its own leg, and everything the resulting session spawns
 * inherits `auto`. Rendering it as just another word next to `semi-auto` loses that, and
 * losing it is how four security->steward return tasks sat unactioned (vikunja#533).
 */
export const WORKFLOW_MODE_DISPLAY: Record<
  WorkflowMode,
  { tone: keyof ThemeColors; hint: string }
> = {
  'semi-auto': {
    tone: 'muted',
    hint: 'operator Start required; every task this one spawns is gated the same way',
  },
  'auto': {
    tone: 'warn',
    hint: 'launches without an operator, and so does everything it spawns',
  },
  'manual-then-auto': {
    tone: 'accent',
    hint: 'operator Start required for this task only — everything it spawns runs auto',
  },
};

export function isWorkflowMode(value: unknown): value is WorkflowMode {
  return typeof value === 'string' && (VALID_WORKFLOW_MODES as readonly string[]).includes(value);
}
