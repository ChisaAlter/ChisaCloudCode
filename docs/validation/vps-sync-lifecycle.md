# VPS execution and synchronization acceptance

This source change fixes native Git-policy admission, workspace isolation,
provider-container ownership and final handback. It does not publish an installer,
activate the new engine or deploy a production service.

## Behavior and retained boundaries

- Native preflight transfers verified immutable Git objects before publishing
  metadata. HEAD recovery uses a durable pending record and exact ownership;
  foreign locks and conflicting metadata remain protected.
- Lease RPCs reuse a serial SSH/Python worker scoped to the exact connection,
  key, project root and binding epoch. Framing, nonce/sequence checks, absolute
  server deadlines, canonical/inode checks and bounded workers preserve failure
  detection. An uncertain send is never replayed automatically.
- Snapshots require fresh native state and a confirmed pause. Immutable source
  objects are read-only in containers; writes use a lease/session-private object
  store. Publication verifies identity and object content after the exact
  container has been confirmed absent. Shared index/refs remain writable only
  under the shared-mode authorization.
- Bound Codex, Cursor and OpenCode executions use the admitted Docker boundary,
  not a host fallback. Terminal completion waits for process cleanup and
  handback. Cancellation and unknown cleanup outcomes keep their safety barrier.
- Each managed app session has a persistent private provider HOME, separate
  read-only credential snapshots and a durable server-owned profile pointer.
  Provider history cannot replace the app's original project identity.
- Dynamic Git policy preserves force-tracked paths while fixed credential/VCS/
  runtime exclusions remain excluded. Rules can be reused for unchanged path
  structure only with fresh content witnesses and matching admission generations.
  A coherent policy change retries without a fatal LastError; pending revalidation
  never counts as a completed cycle or a handback receipt.

Root-clearing confirmation, conflicts, foreign locks, binding identity and
unknown-process protection remain enabled. No TTL or stale snapshot grants new
execution authority.

## Recorded runtime acceptance

The completed isolated fixture exercised a real Windows native controller,
pinned SSH transport, Linux VPS, Git, HTTP callbacks, the existing API image and
UID 1000 Docker workers with dropped capabilities and no-new-privileges.
The model executable itself was replaced with fixed local output. It did not
prove authenticated inference, real CLI credential refresh or installed GUI login.

- Workspace scenarios: **7/7** (isolated Git/snapshot, streaming boundary,
  retained plan identity, shared write/handback, plan freshness, cancellation,
  and lost native-release-reply recovery).
- Provider scenarios: **15/15** across Codex, Cursor and OpenCode. Each covered
  initial isolation, retained resume, plan/read-only, cancellation and shared Git.
  All three shared Git commits succeeded; protected source/config/ref and
  credential checks passed; descendant heartbeats stopped after cancellation.
- Native final handback: **PASS**, 692.59 seconds test time. Final Windows bytes
  and Git metadata matched under a separate exact verification lease, followed
  by its confirmed release.
- Retained resume time: Codex **678.507 ms**, Cursor **777.790 ms**, OpenCode
  **729.163 ms**. These reuse a retained execution root; initial snapshot and
  shared handback still incur the full native proof work.
- Native regression coverage: **333 top-level tests, 328 PASS and 5 explicit
  SKIP**, assembled from recorded segments and fixture corrections. This is not
  one uninterrupted full-suite invocation.

The complete 7+15/native fixture used the archive-structure candidate before the
final retry-state diagnostic correction. The corrected candidate separately
passed controller policy tests (27.041 s), gated capture/validation/hard-error
integration (7.00 s), native pending-admission/failure-barrier tests (5.526 s), and
the full actual WAN repository fixture below. It was not represented as another
complete 7+15 run. The PR's compatibility-port checks are recorded separately in
the PR description, because the public base has additional replay/TLS fixes.

Historical failures were retained: the shared object permission failure led to
the private-object publication fix; an archive-structure-only WAN attempt was
blocked by the temporary-error state mismatch and remained FAIL. A prior fixture
accidentally selected an installed Codex initialization path and attempted catalog/
MCP initialization before failing without an observed completed model response;
the subsequent fixture enforced fixed local model executables. Codex fork/rewind
client regressions use mocked clients, and are not real app-server acceptance.

## Real Windows-to-VPS repository measurements

The same fixture shape used 37,000 tracked files, 4,096 ignored files, 20 sequential
saves and 105 seconds of quiet idle. Each save waited for remote byte verification
and an ACK over an already-open observation channel. Local seeding is separate
from native first import. CPU samples identify the owned process, executable and
start time, and are percentages of one logical core rather than total host load.

| Metric | Frozen baseline | Corrected candidate |
|---|---:|---:|
| Save p50 | 6.321 s | 3.281 s |
| Save p95 | 6.381 s | 3.464 s |
| First save after idle | 4.330 s | 3.045 s |
| Native cold import | 125.430 s | 130.481 s |
| Local seed, separately timed | 57.636 s | 49.014 s |
| Remote agent idle CPU | 1.180% | 1.725% |
| Windows daemon idle CPU | 3.746% | 5.433% |
| Remote agent end RSS | 91.37 MB | 91.73 MB |
| Windows daemon end RSS | 193.02 MB | 258.11 MB |
| Force-track/rename/delete/ignored isolation | PASS | PASS |

Save p50 and p95 decreased **48.10%** and **45.72%**. Saves still have about three
seconds of visible delay. Cold import increased **4.03%**, idle CPU increased at
both sampled processes, and Windows RSS increased. These are known limitations,
not an across-the-board resource improvement. Each candidate had one measured
run, without statistical confidence intervals; SSH/CIM/test observers also add
overhead. The corrected run completed 60 cycles, ended `watching` and passed all
content and post-idle security checks (450.43 s test time).

Separate same-host two-local-endpoint experiments measured Git invocation/output
reductions; those results have a different topology and are not substituted for
the actual WAN latency or total host CPU in this table.

## Reproduction and source identity

The exact `.3` patch is pinned by
[`source-manifest.json`](../../ops/mutagen/source-manifest.json), SHA256
`ae78c79c2557ab884a1cb59fc2210a3d719b8c9ae118e7e164588b3ff648c09f`.
Two clean upstream replays matched all **825** candidate source files. The PR's
published patch was replayed again into a new directory, and all 825 file hashes
matched the measured source. The added explicit build recipe was syntax/interface
checked; it was not run to produce new binaries or packages during PR preparation.
See the [engine instructions](../../ops/mutagen/README.md) for replay, tests and
explicit builds; no model or production deployment is required for local regressions.

The opt-in Windows VPS tests use `-tags vpsqa`, `CHISA_QA_E2E=1` and an explicit
`CHISA_QA_E2E_MANIFEST` outside the repository. They require a new exact task root,
pinned transport resources and matching staged agent bytes. Never point them at
an existing user workspace. The product test's server callback script must be
provided within that owned fixture; no host-specific manifest, private key,
credential, account state or raw runtime log is published here.

All seven remote QA roots were retired after evidence archival and repeated
process/container/mount absence checks. The old native fixture and obsolete
encrypted task credential were removed. Source, regression fixtures and this
sanitized report are the reviewable deliverables; production profiles, images,
services and real projects were not modified.
