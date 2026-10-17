// task-queue-mcp HTTP API client: queue mutations and queue reads.
//
// Mutations (approve/cancel/status/park/unpark/amend/requeue) proxy to the control API so
// they inherit the MCP core's transition validation and fcntl locking; the plugin never
// mutates task YAML. Since v0.11.0 READS go through the API too (GET /tasks,
// GET /tasks/{id}), so the TTL, dead-letter and status rules live in one place, the queue's
// owner, instead of being re-implemented here.
//
// Every request carries this plugin's own client token in `X-Task-Queue-Token`. It is never
// sent as `Authorization`: task-queue-mcp's framework authenticates bearers app-wide, and
// the control routes deliberately read only their own header. See queue-token.ts for where
// the token comes from and why it is not an env var.
//
// `requeue` is the operator's path out of the dead-letter queue. Its MCP *tool* twin
// refuses any agent identity outright; a plugin acting as `operator` over the control API
// is exactly the caller it is meant for.
//
// Extracted from server.ts so the auth/transport guards are unit-testable without booting
// the plugin's HTTP server.

import type { TokenResult } from './queue-token.ts';

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

export const TOKEN_HEADER = 'X-Task-Queue-Token';

/** The largest page task-queue-mcp's GET /tasks returns. */
export const LIST_PAGE_MAX = 1000;

export type ControlAction =
  'approve' | 'cancel' | 'status' | 'park' | 'unpark' | 'amend' | 'requeue';

export interface ControlApiResult {
  status: number;
  data: unknown;
}

export interface ControlApiOptions {
  /** Base URL of the API, no trailing slash (e.g. http://127.0.0.1:8485). */
  apiBase: string;
  /** The loaded client token, or why it could not be loaded. */
  token: TokenResult;
  /** Injectable fetch, for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Why `apiBase` must not carry the token, or null if it may.
 *
 * The token (read + operator-write) goes on every request, reads included. Over plain
 * HTTP to another host, anything on the path could take it and act as the operator. So
 * `http://` is accepted only for a loopback host — the default, `http://127.0.0.1:8485` —
 * and anything else must be `https://`.
 */
export function insecureApiBase(apiBase: string): string | null {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return `TASK_QUEUE_API ${JSON.stringify(apiBase)} is not a URL`;
  }
  if (url.protocol === 'https:' && url.hostname) return null;
  if (url.protocol === 'http:') {
    // URL keeps the brackets on an IPv6 literal.
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)) return null;
  }
  return `TASK_QUEUE_API ${JSON.stringify(apiBase)} refused: the client token is only sent over https://, or over http:// to a loopback host`;
}

/**
 * A request that never left the plugin because it has no usable token. Logged to stderr
 * (captured into the CloudCLI process's PM2 error log) and returned as a 500 whose error
 * names the file, so the UI says exactly what to fix.
 */
function noToken(what: string, error: string): ControlApiResult {
  console.error(`[task-queue] ${what} aborted: ${error}`);
  return { status: 500, data: { ok: false, error } };
}

async function send(
  url: string,
  init: RequestInit,
  what: string,
  opts: ControlApiOptions,
): Promise<ControlApiResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    // Never follow a redirect. fetch's default is to follow, and Undici keeps custom
    // request headers across the hop, X-Task-Queue-Token included. So a redirect from the
    // configured base would hand this read+operator-write token to whatever origin the
    // Location names. insecureApiBase() only vets the configured base, not where a
    // response points next. task-queue-mcp never redirects, so any 3xx is a fault and is
    // reported as one. (Audit 2026-09-30/operator-panel-2026-09-p2-queue-read-api F-01,
    // CodeRabbit CR-03 on #13.)
    const resp = await doFetch(url, { ...init, redirect: 'manual' });
    // The spec returns an opaque-redirect response (type 'opaqueredirect', status 0) for a
    // manual redirect; Node's Undici returns the 3xx itself. Refuse both, and do not read
    // the body: nothing in a redirect response is ours to act on.
    if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
      console.error(`[task-queue] ${what} refused: task-queue-mcp answered with a redirect (${resp.status}); not following it`);
      return { status: 502, data: { ok: false, error: `task-queue API answered with a redirect (${resp.status}); refused` } };
    }
    let data: unknown = {};
    try { data = await resp.json(); } catch { data = {}; }
    if (resp.status === 401 || resp.status === 403) {
      // The token loaded but the server refused it: revoked, never registered, or missing
      // a scope. Say so in the log; the response body carries no token either way.
      console.error(`[task-queue] ${what} refused by task-queue-mcp (${resp.status}): ${JSON.stringify(data)}`);
    }
    return { status: resp.status, data };
  } catch (err) {
    console.error(`[task-queue] ${what} unreachable at ${url}: ${(err as Error).message}`);
    // SECURITY[accepted]: err.message (a Node fetch connection error, e.g. ECONNREFUSED —
    // not a stack trace or internal path) is surfaced to the CloudCLI UI. Client is Ted's
    // authenticated, loopback-bound operator UI; matches the accepted OE-02 precedent from
    // cloudcli-plugin-plane. Genericize if this endpoint is ever exposed beyond loopback.
    return { status: 502, data: { ok: false, error: `task-queue API unreachable: ${(err as Error).message}` } };
  }
}

/**
 * Proxy a queue mutation to the control API. Returns a `{ status, data }` result and never
 * throws; transport failures are mapped to a 502.
 */
export async function callControlApi(
  taskId: string,
  action: ControlAction,
  body: Record<string, unknown>,
  opts: ControlApiOptions,
): Promise<ControlApiResult> {
  if (!VALID_ID.test(taskId)) {
    return { status: 400, data: { ok: false, error: 'invalid task id' } };
  }
  const what = `control API ${action} on task ${taskId}`;
  const insecure = insecureApiBase(opts.apiBase);
  if (insecure) return noToken(what, insecure);
  if (!opts.token.ok) return noToken(what, opts.token.error);

  return send(
    `${opts.apiBase}/tasks/${encodeURIComponent(taskId)}/${action}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: opts.token.token },
      // The server pins the actor to `operator` and ignores this field; it is sent so the
      // request says what it is when read in isolation.
      body: JSON.stringify({ actor: 'operator', ...body }),
    },
    what,
    opts,
  );
}

/**
 * GET a read route. `route` is a path relative to the API base, starting with `/`, with
 * any query string already encoded (see tasksQuery). Never throws.
 */
export async function queueGet(route: string, opts: ControlApiOptions): Promise<ControlApiResult> {
  const what = `read ${route.split('?')[0]}`;
  const insecure = insecureApiBase(opts.apiBase);
  if (insecure) return noToken(what, insecure);
  if (!opts.token.ok) return noToken(what, opts.token.error);
  return send(
    `${opts.apiBase}${route}`,
    { method: 'GET', headers: { [TOKEN_HEADER]: opts.token.token } },
    what,
    opts,
  );
}

/** The route for GET /tasks with these filters. Empty values are dropped, not sent. */
export function tasksQuery(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `/tasks?${s}` : '/tasks';
}

/** A one-line description of a failed API result, for the UI. Never includes a token. */
export function apiErrorMessage(result: ControlApiResult): string {
  const data = result.data as { error?: unknown } | null;
  const detail = typeof data?.error === 'string' ? data.error : 'no detail';
  return `task-queue API ${result.status}: ${detail}`;
}
