/**
 * Agent launch policy — the roster of how each agent's session is started.
 *
 * This plugin used to carry its own `AGENT_PROJECTS` literal in server.ts: a second
 * copy of a table `task-dispatcher.py` also spelled twice. It never gained a steward
 * entry, so the Start button could not launch steward at all — that drift IS
 * vikunja#523. The literal is deleted; both consumers now read one file,
 * `~/scripts/agent-launch.yml`, which ships in host-forge/scripts beside the dispatcher.
 *
 * Extracted from server.ts for the same reason control-api.ts and ws-guard.ts were:
 * server.ts calls server.listen() at import time, so a test importing it boots a
 * listener. Everything here is a pure function of its inputs.
 *
 * The validation is not decoration. The literal existed so no value outside a closed
 * set could reach a subprocess spawn; loading from a file does not preserve that by
 * itself, so every field is checked here against the same closed set the dispatcher's
 * validate_launch_policy() uses, and the WHOLE document is rejected on any violation.
 * A partially-honoured roster would silently launch some agent the wrong way.
 */

import path from 'node:path';
import fs from 'node:fs';
import { load as yamlLoad } from 'js-yaml';
import type { WorkflowMode } from './vocabulary.ts';

// Closed sets. A policy file cannot introduce a user, a launcher directory, or a
// project root outside these — it selects from them.
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const RUN_AS_USER_RE = /^agent-[a-z0-9-]{1,30}$/;
const LAUNCHER_DIR = '/usr/local/sbin/forge/';

export class LaunchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchPolicyError';
  }
}

export interface AgentLaunch {
  projectDir: string;
  /** null for an agent that runs as the plugin's own user. */
  runAsUser: string | null;
  /** Non-null if and only if runAsUser is. */
  launcher: string | null;
}

export type LaunchPolicy = Record<string, AgentLaunch>;

/**
 * Look an agent up in the policy. `target_agent` comes from a queue YAML file, so a
 * plain `policy[agent]` can resolve to `Object.prototype.constructor` and satisfy a
 * truthiness check with something that is not a policy entry at all.
 */
export function lookupAgent(policy: LaunchPolicy, agent: string): AgentLaunch | null {
  // hasOwnProperty via call, not Object.hasOwn: the project targets ES2020, and
  // `policy.hasOwnProperty` is itself absent on a null-prototype object.
  if (typeof agent !== 'string' || !Object.prototype.hasOwnProperty.call(policy, agent)) return null;
  return policy[agent];
}

/** Where the policy file lives. AGENT_LAUNCH_POLICY overrides it for tests. */
export function policyPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.AGENT_LAUNCH_POLICY || path.join(home, 'scripts', 'agent-launch.yml');
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Drop a trailing path separator, so this side agrees with Python's os.path.normpath.
 * The filesystem root is left alone — '/' is not a trailing separator on a name.
 */
function stripTrailingSep(p: string): string {
  return p.length > 1 && p.endsWith(path.sep) ? p.slice(0, -1) : p;
}

/** True if `child` is `root` itself or lies beneath it. Segment-wise, not by prefix. */
function isUnder(root: string, child: string): boolean {
  if (child === root) return true;
  return child.startsWith(root + path.sep);
}

export function validateLaunchPolicy(raw: unknown, home: string): LaunchPolicy {
  // Plain join, no symlink resolution — and the Python side's validate_launch_policy()
  // must keep computing this the same way. It used to call .resolve() here while this
  // side did not, so with a symlink anywhere on the path the two disagreed: Python
  // rejected entries this accepted. Neither side resolves the CANDIDATE project_dir
  // either (it may not exist yet), so resolving only the root compares a canonical path
  // against an uncanonical one, which is not a comparison at all.
  // Found by the security audit of task-queue-plugin-repair-2026-08.
  const projectRoot = path.join(home, '.claude', 'projects');

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new LaunchPolicyError('expected a non-empty mapping of agents');
  }

  // Null prototype, so a lookup by an agent name taken from task content cannot
  // resolve to an inherited member. `{}['constructor']` is truthy, and the caller's
  // `if (!entry)` guard would let it through as if it were a policy entry.
  const policy: LaunchPolicy = Object.create(null) as LaunchPolicy;
  for (const [agent, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!AGENT_NAME_RE.test(agent)) {
      throw new LaunchPolicyError(`invalid agent name ${JSON.stringify(agent)}`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new LaunchPolicyError(`${agent}: expected a mapping`);
    }
    const e = entry as Record<string, unknown>;

    const unknown = Object.keys(e).filter(k => !['project_dir', 'run_as_user', 'launcher'].includes(k));
    if (unknown.length) {
      throw new LaunchPolicyError(`${agent}: unknown key(s) ${unknown.sort().join(', ')}`);
    }

    const rawDir = e.project_dir;
    if (typeof rawDir !== 'string' || !rawDir) {
      throw new LaunchPolicyError(`${agent}: project_dir is required`);
    }
    const expanded = expandHome(rawDir, home);
    if (!path.isAbsolute(expanded)) {
      throw new LaunchPolicyError(`${agent}: project_dir must be absolute: ${rawDir}`);
    }
    // Normalise `..` before the containment check. path.normalize does not follow
    // symlinks, which is right here — the directory may legitimately not exist yet,
    // and the caller reports that with a better message than this could.
    //
    // The trailing separator is then stripped, and that is NOT cosmetic. Node's
    // path.normalize KEEPS a trailing slash ('/a/b/' -> '/a/b/') while Python's
    // os.path.normpath removes it ('/a/b/' -> '/a/b'), so a roster entry written with
    // one produced two different strings on the two sides for the same input — and
    // that string becomes a spawn's cwd. Both sides accepted the entry, so no verdict
    // ever disagreed; only the resolved value did. This is the .resolve() divergence
    // in a second costume, and it is why the shared corpus compares resolved values
    // rather than just accept/reject. Found by that corpus
    // (tests/fixtures/launch-policy-corpus.json in task-dispatcher), not by review.
    const projectDir = stripTrailingSep(path.normalize(expanded));
    if (!isUnder(projectRoot, projectDir)) {
      throw new LaunchPolicyError(`${agent}: project_dir must be under ${projectRoot}: ${rawDir}`);
    }

    const runAsUser = e.run_as_user ?? null;
    const launcher = e.launcher ?? null;
    if ((runAsUser === null) !== (launcher === null)) {
      throw new LaunchPolicyError(`${agent}: run_as_user and launcher must be given together`);
    }
    if (runAsUser !== null) {
      if (typeof runAsUser !== 'string' || !RUN_AS_USER_RE.test(runAsUser)) {
        throw new LaunchPolicyError(`${agent}: invalid run_as_user ${JSON.stringify(runAsUser)}`);
      }
      if (typeof launcher !== 'string' || !launcher.startsWith(LAUNCHER_DIR)) {
        throw new LaunchPolicyError(`${agent}: launcher must be under ${LAUNCHER_DIR}: ${JSON.stringify(launcher)}`);
      }
      if (path.normalize(launcher) !== launcher) {
        throw new LaunchPolicyError(`${agent}: launcher must be a normalised path: ${JSON.stringify(launcher)}`);
      }
    }

    policy[agent] = {
      projectDir,
      runAsUser: runAsUser as string | null,
      launcher: launcher as string | null,
    };
  }
  return policy;
}

/** Read and validate the policy file. Throws LaunchPolicyError; never returns {}. */
export function loadLaunchPolicy(filePath: string, home: string): LaunchPolicy {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new LaunchPolicyError(`cannot read launch policy ${filePath}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = yamlLoad(text);
  } catch (err) {
    throw new LaunchPolicyError(`cannot parse launch policy ${filePath}: ${(err as Error).message}`);
  }
  return validateLaunchPolicy(raw, home);
}

// ── Launch mode vocabulary ───────────────────────────────────────────────────

/** What the plugin's Start button sends. */
export type StartMode = 'review' | 'auto';

/** The closed set behind StartMode, so the type can be checked at runtime too. */
export const START_MODES: readonly StartMode[] = ['review', 'auto'];

/**
 * A `mode` off the wire, or null if it is not one.
 *
 * `POST /tasks/:id/start` used to type-ASSERT its body (`JSON.parse(body) as {mode}`),
 * which is a compile-time claim and no runtime check at all. That was harmless while the
 * value only ever reached `=== 'review'` comparisons that fell through safely — but the
 * run-record build gave it a second consumer that writes it into a task's PERSISTED
 * history note, and a value that lands in a durable record deserves a validator.
 *
 * ABSENT IS NOT INVALID. An omitted mode keeps the long-standing `review` default: the
 * safe leg, the one that reads the task and waits. A PRESENT but unrecognised mode is
 * null and the caller must refuse it — defaulting there would silently downgrade an
 * operator who asked for `auto`, turning a typo into a session that quietly does nothing.
 */
export function toStartMode(raw: unknown): StartMode | null {
  if (raw === undefined || raw === null) return 'review';
  return (START_MODES as readonly string[]).includes(raw as string) ? (raw as StartMode) : null;
}
/**
 * What task-queue-mcp and run-steward.sh accept. Sourced from `vocabulary.ts` rather than
 * spelled again here — this file had its own copy, and copies of this list are vikunja#558.
 */
export type { WorkflowMode };

/**
 * The plugin's Start vocabulary is not the queue's. `review` is a UI word for "let me
 * see it before it runs"; the queue's nearest value is `semi-auto`. Mapped explicitly
 * rather than passed through: `review` is not in task-queue-mcp's VALID_WORKFLOW_MODES,
 * and run-steward.sh would reject it by name. See vikunja#533 for the wider unification.
 *
 * `queuedMode` is the mode the task was SUBMITTED with, and it exists for exactly one
 * value. `manual-then-auto` gates its own leg like `semi-auto` but hands `auto` to
 * everything the session spawns; run-steward.sh implements that downgrade and rejects
 * nothing here. Collapsing it to `semi-auto` on the way out — which is what this function
 * did before #543 — silently pins every downstream handoff back to `semi-auto`, which is
 * the failure vikunja#533 added the mode to fix: four security->steward return tasks sat
 * unactioned for over a week. `review` means "gate this leg", and `manual-then-auto` is
 * the spelling of that which preserves the rest of the chain.
 *
 * An explicit `auto` Start still wins: the operator has said run the whole thing
 * unattended, and a `manual-then-auto` task's children were going to be `auto` regardless.
 */
export function toWorkflowMode(mode: StartMode, queuedMode?: string): WorkflowMode {
  if (mode === 'auto') return 'auto';
  return queuedMode === 'manual-then-auto' ? 'manual-then-auto' : 'semi-auto';
}

// ── argv construction ────────────────────────────────────────────────────────

export interface LaunchArgv {
  argv: string[];
  /** Surfaced to the operator when the requested mode could not be honoured literally. */
  note?: string;
}

/**
 * Build the spawn argv for an agent, mirroring task-dispatcher.py's launch path.
 *
 * A run-as agent goes through its launcher, never through `claude` directly. Spawning
 * `claude` as the plugin's own user for such an agent is the failure this replaces: it
 * bypasses the launcher's identity guard, producing a session that appears as that
 * agent in every log while holding none of its credentials (vikunja#404, #523).
 */
export function buildLaunchArgv(
  entry: AgentLaunch,
  mode: StartMode,
  prompt: string,
  claudeBin: string,
  queuedMode?: string,
): LaunchArgv {
  if (entry.runAsUser && entry.launcher) {
    // -n: never prompt for a password. The sudoers grant is NOPASSWD, so a prompt
    // would mean the grant is gone — fail immediately rather than hang on a tty
    // that does not exist.
    // --: everything after is the prompt, not a flag.
    const argv = [
      'sudo', '-n', '-u', entry.runAsUser,
      entry.launcher,
      '--workflow-mode', toWorkflowMode(mode, queuedMode),
      '--', prompt,
    ];
    // run-steward.sh sets --dangerously-skip-permissions itself and accepts no
    // permission-mode, so `review` cannot be enforced by the CLI for a run-as agent
    // the way it is for one launched directly. The review prompt still instructs the
    // agent to stop and wait, but that is a prompt-level control, not a tool gate.
    // Say so rather than implying a guarantee that is not there.
    let note = mode === 'review'
      ? 'review is prompt-enforced for this agent — its launcher does not accept a permission mode'
      : undefined;
    if (mode === 'review' && queuedMode === 'manual-then-auto') {
      note = (note ? note + '. ' : '')
        + 'queued manual-then-auto — this leg is gated, everything it spawns runs auto';
    }
    return { argv, note };
  }

  const permissionMode = mode === 'review' ? 'plan' : 'default';
  return { argv: [claudeBin, '-p', prompt, '--permission-mode', permissionMode] };
}

/**
 * Launch-log filename. Shared with task-dispatcher.py, which writes the same shape into
 * the same directory — previously it wrote ~/.pm2/logs/agent-launch-<agent>-<task8>.log
 * while this plugin wrote <taskId>.log, so nothing could list "the launches".
 */
export function launchLogName(agent: string, taskId: string): string {
  return `${agent}-${taskId.slice(0, 8)}.log`;
}

/**
 * Run-record filename — the log's stem with a `.json` suffix. Also shared with
 * task-dispatcher (run_record_name()). Defined here rather than in run-record.ts so the
 * two names that must agree sit next to each other; splitting them is how the stem drifts.
 */
export function runRecordFileName(agent: string, taskId: string): string {
  return `${agent}-${taskId.slice(0, 8)}.json`;
}
