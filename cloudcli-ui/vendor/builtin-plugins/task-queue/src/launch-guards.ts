/**
 * Pre-launch credential guards, ported from task-dispatcher's launch path.
 *
 * WHY (plan agent-workflow-interop-2026-08, Phase 5.6)
 *
 * The dispatcher refuses to spawn a directly-launched agent without a resolved
 * `SCOPED_MCP_BEARER_TOKEN` and without a usable Anthropic credential, and says which one
 * is missing by name. This plugin had neither check, so a Start could spawn a session
 * doomed to fail deep inside — a 401 from every scoped-mcp tool, or a `claude -p` that
 * short-circuits to "Not logged in" and never reads the task prompt. Both look, from the
 * operator's side, like an agent that started and did nothing.
 *
 * THE PORT IS NOT JUST THE TWO CHECKS. The dispatcher layers
 * `/opt/appdata/agents/<agent>/.env` into the child environment before checking it
 * (`load_agent_env`, mirroring what `run-scoped-mcp-http.sh` sources server-side); this
 * plugin spawned with a bare `{...process.env}`. Measured on forge: the CloudCLI process
 * env carries `CLAUDE_CODE_OAUTH_TOKEN` but NO `SCOPED_MCP_BEARER_TOKEN`. So a guard that
 * checked only `process.env` would have refused every non-run-as Start — correctly, in the
 * sense that those sessions really were starting without scoped-mcp tools, but that is the
 * bug rather than the fix. Layering the agent's own env is what makes the guard a guard
 * instead of a blanket refusal, and it is what the dispatcher has always done.
 *
 * THE RUN-AS ASYMMETRY IS DELIBERATE — DO NOT "FIX" IT
 *
 * Neither check runs for an agent with `runAsUser` set, exactly as in the dispatcher. For
 * such an agent the credentials are not in this process's environment BY DESIGN: they live
 * in a file owned by and readable only by the target user, and the launcher sources them as
 * that user. Running these checks on that path would fail every launch for the one agent
 * whose isolation is working correctly.
 *
 * The launcher performs the equivalent fail-loud checks itself, by name and as the right
 * user (`: "${VAR:?}"` on SCOPED_MCP_BEARER_TOKEN, TASK_QUEUE_TOKEN, GITHOST_MCP_AUTH_TOKEN,
 * CLAUDE_CODE_OAUTH_TOKEN). What it cannot cover is the launcher itself being absent, and
 * the caller already checks that separately.
 */

import fs from 'node:fs';
import { isTerminal } from './vocabulary.ts';
import path from 'node:path';

/** Where each agent's server-side environment file lives. */
const AGENT_ENV_ROOT = '/opt/appdata/agents';

/**
 * The same shape the roster's agent names are validated against. Re-checked here rather
 * than trusted, because this value becomes a path segment: callers reach this function
 * with a name that came out of a queue YAML, and a validated-elsewhere invariant is one
 * refactor away from not holding.
 */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Parse a KEY=VALUE file. A missing or unreadable file is an empty object, not an error —
 * an agent may legitimately have none, and the caller's check is on the RESULT.
 *
 * Mirrors task-dispatcher's `read_env_file` deliberately, including its documented
 * deviations from `source`: no `$VAR` expansion, no `export ` prefix, no line
 * continuations. These files are written by this fleet and every one is flat KEY=VALUE.
 * The quote handling repeats Python's `.strip().strip('"').strip("'")` in the same order,
 * because "one layer of quoting" and "all leading/trailing quote characters" differ on
 * inputs like `""x""` and the two sides must agree on which they implement.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    value = value.replace(/^"+/, '').replace(/"+$/, '');
    value = value.replace(/^'+/, '').replace(/'+$/, '');
    env[key] = value;
  }
  return env;
}

/**
 * Read `/opt/appdata/agents/<agent>/.env`, or `{}` if it is absent or unreadable.
 *
 * `envRoot` is injectable so tests need not own a path under /opt.
 */
export function loadAgentEnv(agent: string, envRoot: string = AGENT_ENV_ROOT): Record<string, string> {
  if (!AGENT_NAME_RE.test(agent)) return {};
  try {
    return parseEnvFile(fs.readFileSync(path.join(envRoot, agent, '.env'), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Whether a headless `claude -p` launched with this environment can authenticate.
 *
 * Ported from the dispatcher's `anthropic_creds_usable` (SMCP-29/SMCP-32). Any one of the
 * three token variables is sufficient — they short-circuit the same way — and the OAuth
 * file is the last resort.
 *
 * `expiresAt > now` is a correct usability test here rather than an over-strict one:
 * headless mode does NOT interactively refresh an expired OAuth token, it prints the login
 * prompt instead. So an expired token is genuinely unusable, not merely stale.
 */
export function anthropicCredsUsable(
  env: Record<string, string | undefined>,
  oauthPath: string,
  now: number = Date.now(),
): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  try {
    const oauth = (JSON.parse(fs.readFileSync(oauthPath, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    }).claudeAiOauth;
    if (!oauth?.accessToken) return false;
    return (oauth.expiresAt ?? 0) > now;
  } catch {
    return false;
  }
}

export interface GuardOk {
  ok: true;
  /** The environment the child should be spawned with. */
  env: Record<string, string | undefined>;
}
export interface GuardFail {
  ok: false;
  error: string;
}

export interface GuardOptions {
  /** Injectable for tests; defaults to the real locations. */
  envRoot?: string;
  oauthPath: string;
  now?: number;
}

/**
 * Build the child environment and refuse the launch if it cannot possibly authenticate.
 *
 * Returns the environment to spawn with on success — the caller must use it rather than
 * rebuilding one, or the thing that was checked and the thing that is used come apart,
 * which is how a guard becomes decoration.
 *
 * `runAsUser` short-circuits BOTH checks and returns the parent environment untouched. See
 * the module header: that asymmetry is the correct behaviour, not an oversight.
 */
export function preLaunchEnv(
  agent: string,
  runAsUser: string | null,
  parentEnv: Record<string, string | undefined>,
  opts: GuardOptions,
): GuardOk | GuardFail {
  if (runAsUser) {
    // sudo scrubs the environment anyway, and the launcher sources the agent's
    // credentials as the target user. Checking this process's env would be asking the
    // wrong question of the wrong user.
    return { ok: true, env: parentEnv };
  }

  const env = { ...parentEnv, ...loadAgentEnv(agent, opts.envRoot) };

  if (!env.SCOPED_MCP_BEARER_TOKEN) {
    return {
      ok: false,
      error:
        `SCOPED_MCP_BEARER_TOKEN unresolved for agent '${agent}' — refusing to launch. `
        + `.mcp.json interpolates bare $VAR only, with no :?/:- operators, so an unresolved `
        + `token fails as a 401 deep inside the session instead of here.`,
    };
  }

  if (!anthropicCredsUsable(env, opts.oauthPath, opts.now)) {
    return {
      ok: false,
      error:
        `No usable Anthropic credential (OAuth expired, or no ANTHROPIC_API_KEY / `
        + `ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN) — refusing to launch '${agent}'. `
        + `Run \`claude /login\` to restore headless launches.`,
    };
  }

  return { ok: true, env };
}

/**
 * Why a Start must not launch a session for this task, or null if it may.
 *
 * The task lookup goes through task-queue-mcp's `GET /tasks/{id}`, which also resolves
 * archived and dead-lettered records. Before v0.11.0 the plugin scanned only the live
 * queue directory, so Start could never reach them. Viewing them is useful; launching an
 * agent at one is not. A dead letter's route is to Requeue, and a finished task has
 * nothing left to do. The agent would be refused when it tried to claim, but by then a
 * session has already been spawned.
 */
export function launchRefusal(task: { queue_location?: unknown; status?: unknown }): string | null {
  const location = typeof task.queue_location === 'string' ? task.queue_location : 'queue';
  if (location !== 'queue') return `task is in ${location}, not the live queue`;
  const status = typeof task.status === 'string' ? task.status : '';
  if (isTerminal(status)) return `task is ${status}`;
  return null;
}
