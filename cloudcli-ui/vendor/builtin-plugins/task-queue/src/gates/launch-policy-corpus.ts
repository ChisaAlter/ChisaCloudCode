/**
 * Assert this plugin's validateLaunchPolicy() agrees with task-dispatcher's, case for case.
 *
 * WHY THIS EXISTS (plan agent-workflow-interop-2026-08, Phase 5.5)
 *
 * `~/scripts/agent-launch.yml` has two independent validators — the dispatcher's Python
 * `validate_launch_policy()` and this repo's `validateLaunchPolicy()`. Both feed values into
 * a subprocess spawn, and neither shares a line of code with the other. `launch-policy.ts`
 * carried a comment stating that the Python side "must keep computing this the same way",
 * which is a comment where a test should be.
 *
 * They have already disagreed. Python called `.resolve()` on the project root while this
 * side did a plain join, so with a symlink anywhere on the path the two diverged — and
 * because `LAUNCH_POLICY = load_launch_policy()` runs at import, the effect on forge was not
 * a rejected entry but the dispatcher module failing to import on every tick.
 *
 * WHY IT COMPARES RESOLVED VALUES, NOT JUST VERDICTS
 *
 * A verdict-only comparison would have reported these two implementations in perfect
 * agreement throughout that bug, and through a second one this gate found on its first run:
 * Node's `path.normalize` keeps a trailing separator while Python's `os.path.normpath`
 * strips it, so `~/.claude/projects/writer/` was ACCEPTED by both sides and resolved to two
 * different strings — one of which becomes a spawn's `cwd`. Verdicts are the cheap half of
 * the contract.
 *
 * DIRECTION AND MECHANISM
 *
 * task-dispatcher owns the corpus; this side fetches it from that repo's `main` over HTTPS.
 * Same direction and mechanism as `vocabulary-parity.ts`, so this fleet has one pattern for
 * cross-repo contracts rather than two. Nothing fetched is executed — it is parsed as JSON
 * and its `policy` values are fed to a pure function.
 *
 * DELIBERATELY NOT SKIPPABLE
 *
 * There is no "no network, skip" path and no vendored copy. A parity check that quietly
 * passes when it could not read the upstream is indistinguishable from one that verified
 * something. Nor does it tolerate an empty case list: zero cases is the fetch or the parse
 * being broken, not the two validators agreeing, and reporting a vacuous pass over an empty
 * comparison is the same failure wearing a green tick.
 *
 * CONSEQUENCE WORTH KNOWING: this tracks task-dispatcher's `main`. A case added there turns
 * this repo's CI red on the next push if the two sides genuinely differ. That is the alarm.
 * Fix `launch-policy.ts` — do not edit this gate, and do not delete a case upstream.
 *
 * Run: `npm run gate:corpus`. Its OWN CI step, not part of `npm test`: a red here means "go
 * make this validator match the dispatcher's", which is a different instruction from any
 * unit failure, and folding the two together lets either hide the other.
 */

import { validateLaunchPolicy, LaunchPolicyError } from '../launch-policy.ts';

// `main` is the contract — it is what the dispatcher is running. The override exists for
// the one situation that recurs whenever the corpus changes: a paired change lands in two
// repos and this one is legitimately ahead of task-dispatcher's `main` until its PR merges.
//
// CI MUST NOT SET THIS. It defaults to `main` precisely so an unset environment gets the
// strict check.
const UPSTREAM_REF = process.env.TASK_DISPATCHER_REF ?? 'main';

// The ref is interpolated into a URL path, so constrain it. `..` would traverse out of this
// repo's path segment on raw.githubusercontent.com and fetch somebody else's corpus — which
// this gate would then treat as authoritative.
if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(UPSTREAM_REF) || UPSTREAM_REF.includes('..')) {
  console.error(`FATAL: refusing TASK_DISPATCHER_REF=${JSON.stringify(UPSTREAM_REF)} — not a plain git ref`);
  process.exit(2);
}

const UPSTREAM_URL =
  `https://raw.githubusercontent.com/TadMSTR/task-dispatcher/${UPSTREAM_REF}`
  + '/tests/fixtures/launch-policy-corpus.json';

// A synthetic home. Nothing here touches the real one and no directory needs to exist —
// validation is about shape, not about the filesystem. The corpus writes `{HOME}` rather
// than a literal path because each side substitutes its OWN home: Python expands `~`
// against the ambient $HOME while this side expands it against this argument, so a
// hardcoded path would make the two incomparable for exactly the `~` cases.
const HOME = '/home/testuser';

interface CorpusCase {
  name: string;
  why?: string;
  policy: unknown;
  expect: 'accept' | 'reject';
  resolved?: Record<string, { project_dir: string; run_as_user: string | null; launcher: string | null }>;
}

const failures: string[] = [];

function check(cond: boolean, label: string): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures.push(label);
}

/** Substitute {HOME} through a nested structure, leaving non-strings alone. */
function sub(value: unknown): unknown {
  if (typeof value === 'string') return value.split('{HOME}').join(HOME);
  if (Array.isArray(value)) return value.map(sub);
  if (value !== null && typeof value === 'object') {
    // Object.entries, then a fresh object: a corpus case deliberately contains
    // `__proto__` as an agent name, and a spread or an index assignment onto `{}` would
    // either drop it or mutate the prototype instead of setting a key. Object.create(null)
    // has no prototype to pollute and keeps the key where the validator can reject it.
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(out, k, { value: sub(v), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

async function fetchCorpus(): Promise<CorpusCase[]> {
  let text: string;
  try {
    // SECURITY[accepted]: no `redirect: "manual"`, deviating from baseline pattern SSRF-02 —
    // the same accepted deviation as vocabulary-parity.ts, for the same reasons. Host and
    // path are literals, only the ref segment varies and it is charset-checked and
    // `..`-rejected above, and the response is parsed as JSON and never executed. Worst case
    // from a hostile redirect is a false red (loud, blocks CI) or a false green requiring the
    // attacker to serve a corpus this validator already satisfies, which achieves nothing.
    const resp = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    text = await resp.text();
  } catch (err) {
    console.error(`FATAL: could not read the launch-policy corpus at ${UPSTREAM_URL}`);
    console.error(`       ${(err as Error).name}: ${(err as Error).message}`);
    console.error(
      '       This is a hard failure on purpose — see the header. A parity check that skips '
      + 'when it cannot read the upstream reports the same result whether or not the two '
      + 'validators agree.',
    );
    process.exit(2);
  }

  let parsed: { cases?: CorpusCase[] };
  try {
    parsed = JSON.parse(text) as { cases?: CorpusCase[] };
  } catch (err) {
    console.error(`FATAL: the corpus at ${UPSTREAM_URL} is not valid JSON: ${(err as Error).message}`);
    process.exit(2);
  }

  const cases = parsed.cases ?? [];
  if (cases.length === 0) {
    console.error(
      `FATAL: no cases parsed from ${UPSTREAM_URL} — the fetch or the shape is broken, not `
      + 'the validators. Failing rather than reporting a vacuous pass over an empty corpus.',
    );
    process.exit(2);
  }
  return cases;
}

async function main(): Promise<number> {
  console.log('launch policy parity (plugin ↔ task-dispatcher, shared corpus)');
  console.log(`  upstream: ${UPSTREAM_URL}`);
  if (UPSTREAM_REF !== 'main') {
    console.log(
      `  NOTE: comparing against ref ${JSON.stringify(UPSTREAM_REF)}, NOT main. This is a `
      + 'pre-merge check and does not prove parity with what is deployed.',
    );
  }

  const cases = await fetchCorpus();
  console.log(`  ${cases.length} case(s)`);

  for (const c of cases) {
    let got: Record<string, { projectDir: string; runAsUser: string | null; launcher: string | null }> | null = null;
    let verdict: 'accept' | 'reject';
    let error: string | null = null;
    try {
      got = validateLaunchPolicy(sub(c.policy), HOME);
      verdict = 'accept';
    } catch (err) {
      if (!(err instanceof LaunchPolicyError)) {
        // A TypeError here means the validator crashed rather than refusing, which is a
        // different and worse failure than a wrong verdict — say so by name.
        check(false, `corpus[${c.name}]: threw ${(err as Error).name}, not LaunchPolicyError: ${(err as Error).message}`);
        continue;
      }
      verdict = 'reject';
      error = err.message;
    }

    if (verdict !== c.expect) {
      check(false, `corpus[${c.name}]: expected ${c.expect}, got ${verdict}${error ? ` (${error})` : ''}`);
      continue;
    }
    check(true, `corpus[${c.name}]: ${verdict}`);

    if (c.expect !== 'accept' || !c.resolved) continue;

    // The resolved values, in the corpus's field names. This is the half a verdict-only
    // comparison misses — see the header.
    const want = sub(c.resolved) as Record<string, Record<string, string | null>>;
    const flat: Record<string, Record<string, string | null>> = {};
    for (const [agent, entry] of Object.entries(got!)) {
      flat[agent] = {
        project_dir: entry.projectDir,
        run_as_user: entry.runAsUser,
        launcher: entry.launcher,
      };
    }
    const wantKeys = Object.keys(want).sort();
    const gotKeys = Object.keys(flat).sort();
    const same =
      JSON.stringify(wantKeys) === JSON.stringify(gotKeys)
      && wantKeys.every(a =>
        (['project_dir', 'run_as_user', 'launcher'] as const).every(f => flat[a][f] === want[a][f]));

    check(
      same,
      same
        ? `corpus[${c.name}]: resolved values match`
        : `corpus[${c.name}]: resolved ${JSON.stringify(flat)} != expected ${JSON.stringify(want)}`,
    );
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`LAUNCH POLICY PARITY DRIFT (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    console.error(
      'This plugin and task-dispatcher disagree about a roster both of them feed into a '
      + 'subprocess spawn. Fix src/launch-policy.ts to match — or, if the DISPATCHER is the '
      + 'one that is wrong, fix it there and the corpus with it. Do not edit this gate, and '
      + 'do not delete the case.',
    );
    return 1;
  }
  console.log('both validators agree on every case');
  return 0;
}

process.exit(await main());
