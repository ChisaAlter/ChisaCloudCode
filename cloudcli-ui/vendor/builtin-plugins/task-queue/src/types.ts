// ── CloudCLI Plugin API (from host) ────────────────────────────────────

export interface PluginContext {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
}

export interface PluginAPI {
  readonly context: PluginContext;
  onContextChange(callback: (ctx: PluginContext) => void): () => void;
  rpc(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>;
  unmount?(container: HTMLElement): void;
}

// ── Theme ──────────────────────────────────────────────────────────────

export interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  error: string;
}

// ── Task types ─────────────────────────────────────────────────────────

export interface TaskHistoryEntry {
  timestamp: string;
  status: string;
  actor: string;
  note: string;
  /** Present on non-status actions, e.g. 'amend'. */
  action?: string;
  /** Set when the transition used the operator override path. */
  override?: boolean;
}

/**
 * An append-only correction to a queued task. The task's original
 * `payload.description` is never rewritten — amendments are rendered after it.
 */
export interface TaskAmendment {
  timestamp: string;
  actor: string;
  reason?: string;
  text: string;
}

export interface Task {
  id: string;
  created: string;
  source_agent: string;
  target_agent: string;
  task_type: string;
  risk_level: string;
  requires_approval: boolean;
  status: string;
  summary: string;
  ttl_days: number;
  /**
   * `semi-auto` | `auto` | `manual-then-auto` — see `vocabulary.ts`. Optional because
   * records written before task-queue-mcp added the field carry none, and a task with no
   * recorded mode is rendered as unknown rather than as the queue's default.
   */
  workflow_mode?: string;
  /** Status to return to on unpark. Present only while status === 'parked'. */
  parked_from?: string;
  /**
   * Written by task-dispatcher while a task sits at `routing-failed`. Read-only here — it
   * is what lets the detail panel say when the next attempt is due instead of leaving the
   * status as a bare word.
   */
  retry_policy?: {
    retry_count?: number;
    max_retries?: number;
    next_retry_at?: string | null;
    last_failure_reason?: string;
  };
  payload: {
    description: string;
    context_refs?: string[];
    priority?: string;
    amendments?: TaskAmendment[];
  };
  result: {
    output: string | null;
    completed_by: string | null;
    completed_at: string | null;
  };
  history: TaskHistoryEntry[];
}

// ── Dead letters ───────────────────────────────────────────────────────

/**
 * One record from `~/.claude/task-queue/dead-letters/` — a task task-dispatcher gave up
 * routing after exhausting its retries. It is not live work: nothing will pick it up, and
 * it cannot be transitioned until an operator requeues it.
 *
 * Defined here rather than separately in server.ts and index.ts so the route's response
 * shape has exactly one definition across the bundle boundary, same as HeadlessRun.
 */
export interface DeadLetter {
  id: string;
  created: string;
  source_agent: string;
  target_agent: string;
  task_type: string;
  summary: string;
  /** `failed_reason.reason` — the thing to group on. */
  reason: string;
  /** `failed_reason.timestamp`; '' when the record carries none. */
  failed_at: string;
  retry_count: number;
}

/** Dead letters sharing one failure reason. N identical reasons are one problem. */
export interface DeadLetterGroup {
  reason: string;
  count: number;
  letters: DeadLetter[];
}

// ── Headless runs ──────────────────────────────────────────────────────

/**
 * One headless agent run, derived from its launch log file. Defined here rather than
 * separately in server.ts and index.ts so the route's response shape has exactly one
 * definition — the two are a single contract across the bundle boundary.
 */
export interface HeadlessRun {
  /** `<agent>-<task8>` — the route id, and the log filename without `.log`. */
  id: string;
  agent: string;
  task_id8: string;
  /** Full task id, when a live queue task matches the prefix. */
  task_id: string | null;
  /**
   * Derived from the QUEUE, not from the log. A log proves a session ran; it does not
   * prove its task closed. When the two disagree that is signal worth rendering.
   */
  status: string;
  started: string;
  ended: string;
  /** null when the start time is unknowable — render as unknown, never as zero. */
  duration_s: number | null;
  size: number;
  first_line: string;
  /**
   * True when a run record was found beside the log. False for the 29 logs that predate
   * run records, whose times are still derived from file mtimes — the fields below are
   * all null for those, and the UI says "no run record" rather than implying an outcome.
   */
  has_record: boolean;
  /** 'dispatcher' | 'dispatcher-audit' | 'plugin', or null without a record. */
  launched_by: string | null;
  /**
   * How the run ended, in one phrase, or null while it is open or unrecorded. NEVER
   * derived from the log's prose — see outcomeLabel().
   */
  outcome: string | null;
  /** null is an honest unknown for a dispatcher launch, not a missing value. */
  exit_code: number | null;
  /**
   * False when the record names a log this UI may not read — the security-audit launcher
   * writes to ~/.pm2/logs, which is deliberately outside the preview allowlist because
   * that prefix covers every PM2 service log on the host. The row still renders; the
   * detail view says where the log is instead of pretending it is empty.
   */
  log_readable: boolean;
}

export interface HeadlessRunDetail {
  id: string;
  agent: string;
  task_id8: string;
  task_id: string | null;
  status: string;
  text: string;
  /** Fenced code blocks scraped from the log, offered with copy buttons. */
  commands: string[];
  truncated: boolean;
  has_record: boolean;
  launched_by: string | null;
  outcome: string | null;
  exit_code: number | null;
  /** Absolute path of the log, from the record. Shown when it is not readable here. */
  log_path: string | null;
  log_readable: boolean;
}
