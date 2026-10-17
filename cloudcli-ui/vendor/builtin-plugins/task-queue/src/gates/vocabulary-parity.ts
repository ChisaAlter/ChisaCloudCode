/**
 * Assert src/vocabulary.ts's task-queue vocabulary equals task-queue-mcp's.
 *
 * WHY THIS EXISTS (vikunja#558)
 *
 * This plugin is a reader and an operator surface for a queue whose schema lives in
 * another repo. It carried hand-written copies of that vocabulary in four places, none of
 * which learned about `routing-failed` when task-queue-mcp made it a first-class
 * non-terminal status — so the status most in need of an operator sorted below
 * `cancelled`, rendered in the same grey as `parked`, and was not offered by the filter.
 * `manual-then-auto` (#543) was the same omission one field over. Nothing detected either:
 * a missing key in a `Record<string, …>` is not a type error, and a `switch` with a
 * `default` has no missing case.
 *
 * This is the same check `task-dispatcher/tests/test_task_queue_vocabulary.py` runs at the
 * dispatcher edge (vikunja#324), ported to this one.
 *
 * HOW
 *
 * The MCP is a separate, public repo, so this reads its source over HTTP and parses the
 * set literals textually. Nothing fetched is ever executed, and no Python runs — a
 * deliberately narrow tokenizer accepts a brace-delimited list of plain string literals
 * and refuses everything else. Our own side is imported directly, because vocabulary.ts is
 * a constants module with no side effects; that is the one asymmetry with the Python
 * version, which reads its own source with `ast` because cli.py is not importable cheaply.
 *
 * DELIBERATELY NOT SKIPPABLE
 *
 * There is no "no network, skip" path, and no cached copy to fall back to. A vocabulary
 * check that quietly passes when it could not read the upstream is indistinguishable from
 * one that verified something, and that shape — a probe that reports success without
 * asserting anything — is how #324 stayed open for months. If this cannot reach the
 * upstream it exits non-zero, and the fix is to make the network work.
 *
 * The same reasoning covers the parse: if zero set literals come back, that is the
 * extraction being broken rather than the vocabulary being in sync, and it fails rather
 * than reporting a vacuous pass over an empty comparison.
 *
 * CONSEQUENCE WORTH KNOWING: this tracks task-queue-mcp's `main`, not a pin. A vocabulary
 * change merged there turns this repo's CI red on the next push. That is the alarm, not a
 * malfunction — the plugin is genuinely out of date at that moment. Update
 * src/vocabulary.ts and it goes green. `tsc` will then hold it red until any new status
 * has a sort position and a colour, which is the second half of the fix.
 *
 * Run: `npm run gate:vocabulary`. It is its OWN CI step, not part of `npm test` — a red
 * vocabulary means "go edit src/vocabulary.ts", which is a different instruction from any
 * unit failure, and folding the two together lets either hide the other.
 */

import { literalSets } from './python-sets.ts';
import {
  VALID_STATUSES,
  TERMINAL_STATUSES,
  NON_TERMINAL_STATUSES,
  VALID_TASK_TYPES,
  VALID_WORKFLOW_MODES,
} from '../vocabulary.ts';

// The ref to compare against. `main` is the contract — that is what is deployed and what
// this plugin must agree with.
//
// The override exists for ONE situation, which is not hypothetical: a paired change lands
// in two repos and this one is legitimately ahead of the MCP's `main` until the MCP's PR
// merges. Without it the only way to see whether the rest of the pipeline is green is to
// merge first and find out.
//
// CI MUST NOT SET THIS. It defaults to `main` precisely so an unset environment gets the
// strict check; a pipeline that pinned it to a feature branch would be asserting parity
// with something nobody is running. Use it from a shell, note it in the PR, and let the
// post-merge run be the one that counts.
const UPSTREAM_REF = process.env.TASK_QUEUE_MCP_REF ?? 'main';

// The ref is interpolated into a URL path, so constrain it. `..` in particular would
// traverse out of this repo's path segment on raw.githubusercontent.com and fetch somebody
// else's queue.py — which this gate would then compare against and report as
// authoritative. It needs control of the environment to exploit, but it is free to close.
if (!/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(UPSTREAM_REF) || UPSTREAM_REF.includes('..')) {
  console.error(`FATAL: refusing TASK_QUEUE_MCP_REF=${JSON.stringify(UPSTREAM_REF)} — not a plain git ref`);
  process.exit(2);
}

const UPSTREAM_URL =
  `https://raw.githubusercontent.com/TadMSTR/task-queue-mcp/${UPSTREAM_REF}/src/tools/queue.py`;

/**
 * Every set both sides must agree on, upstream name -> our value. They happen to be spelled
 * the same here; the mapping is kept explicit anyway, because what matters is the contents
 * and a future rename should be a one-line edit rather than a restructure.
 *
 * NON_TERMINAL_STATUSES is absent on purpose: upstream derives it
 * (`VALID_STATUSES - TERMINAL_STATUSES`) rather than writing a literal, so there is nothing
 * to parse. It is checked separately, derived on both sides.
 */
const SHARED: Record<string, readonly string[]> = {
  VALID_STATUSES,
  TERMINAL_STATUSES,
  VALID_TASK_TYPES,
  VALID_WORKFLOW_MODES,
};

const failures: string[] = [];

function check(cond: boolean, label: string): void {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}`);
  if (!cond) failures.push(label);
}

/**
 * Every module-level string-set literal upstream, or a hard failure.
 *
 * An empty result is the extraction being broken, not the vocabulary being in sync — so it
 * exits rather than reporting a vacuous pass over an empty comparison. The parser itself is
 * in `python-sets.ts` with its own tests; only this exit decision lives here.
 */
function upstreamSets(source: string, origin: string): Map<string, string[]> {
  const found = literalSets(source);
  if (found.size === 0) {
    console.error(
      `FATAL: no set literals parsed from ${origin} — the extraction is broken, not the `
      + 'vocabulary. Failing rather than reporting a vacuous pass.',
    );
    process.exit(2);
  }
  return found;
}

async function fetchUpstream(): Promise<string> {
  try {
    // SECURITY[accepted]: no `redirect: "manual"`, deviating from baseline pattern SSRF-02.
    // The URL is not caller-supplied — host and path are literals, only the ref segment
    // varies, and it is charset-checked and `..`-rejected above. The response is never
    // executed: python-sets.ts accepts only a brace-delimited list of plain string literals.
    // Worst case from a hostile redirect is a false red (loud, blocks CI) or a false green
    // requiring the attacker to serve the exact correct value sets, which achieves nothing.
    // Following redirects beats breaking the gate if GitHub ever 302s this path. Reviewed
    // and accepted 2026-08-29 — agent-workflow-interop-2026-08-phase2 audit, INFO 1; row in
    // host-forge-knowledge-base/security/accepted-risks.md. Revisit if this is ever made to
    // accept a caller-supplied URL or host.
    const resp = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } catch (err) {
    console.error(`FATAL: could not read the vocabulary source of truth at ${UPSTREAM_URL}`);
    console.error(`       ${(err as Error).name}: ${(err as Error).message}`);
    console.error(
      '       This is a hard failure on purpose — see the header. A vocabulary check that '
      + 'skips when it cannot read the upstream reports the same result whether or not the '
      + 'two sides agree.',
    );
    process.exit(2);
  }
}

function compare(label: string, ours: readonly string[], theirs: readonly string[]): void {
  const o = new Set(ours);
  const t = new Set(theirs);
  const onlyOurs = [...o].filter(v => !t.has(v)).sort();
  const onlyTheirs = [...t].filter(v => !o.has(v)).sort();
  if (onlyOurs.length === 0 && onlyTheirs.length === 0) {
    check(true, `${label} (${o.size} values)`);
    return;
  }
  const detail: string[] = [];
  if (onlyOurs.length) detail.push(`plugin-only: [${onlyOurs.join(', ')}]`);
  if (onlyTheirs.length) detail.push(`mcp-only: [${onlyTheirs.join(', ')}]`);
  check(false, `${label} — ${detail.join('; ')}`);
}

async function main(): Promise<number> {
  console.log('task queue vocabulary parity (plugin ↔ task-queue-mcp)');
  console.log(`  upstream: ${UPSTREAM_URL}`);
  if (UPSTREAM_REF !== 'main') {
    console.log(
      `  NOTE: comparing against ref ${JSON.stringify(UPSTREAM_REF)}, NOT main. This is a `
      + 'pre-merge check and does not prove parity with what is deployed.',
    );
  }

  const mcp = upstreamSets(await fetchUpstream(), 'task-queue-mcp/src/tools/queue.py');

  for (const [name, ours] of Object.entries(SHARED)) {
    const theirs = mcp.get(name);
    if (!theirs) {
      check(false, `${name} is missing from task-queue-mcp — renamed upstream?`);
      continue;
    }
    compare(name, ours, theirs);
  }

  // Derived on both sides, so this asserts our subtraction as well as the two sets feeding
  // it. Skipped if either input failed to parse — reporting it too would be one drift
  // counted twice.
  const upStatuses = mcp.get('VALID_STATUSES');
  const upTerminal = mcp.get('TERMINAL_STATUSES');
  if (upStatuses && upTerminal) {
    const upNonTerminal = upStatuses.filter(s => !upTerminal.includes(s));
    compare('NON_TERMINAL_STATUSES (derived both sides)', NON_TERMINAL_STATUSES, upNonTerminal);
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`VOCABULARY DRIFT (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error('');
    console.error(
      'Fix by editing src/vocabulary.ts to match task-queue-mcp, then giving any new '
      + 'status a STATUS_ORDER position and a STATUS_COLOR entry — tsc will insist. '
      + 'Do not edit this gate to make it pass.',
    );
    return 1;
  }
  console.log('vocabulary is in sync');
  return 0;
}

process.exit(await main());
