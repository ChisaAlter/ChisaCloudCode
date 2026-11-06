# Retired synchronization engine archive

The cloud-only desktop no longer builds, bundles, enrolls, starts or resumes this
engine. This directory is retained for historical source/manifest review only.
The commands and product descriptions below document the retired 0.18.1-chisa.4
release; they are not current installation, upgrade or packaging instructions.
No native build script imports these replay tools. Current startup retirement
uses a separate exact-session pause path and never executes the old batch drain
or daemon restart procedure. Do not use these historical commands on user data.

## Historical 0.18.1-chisa.4 source record

This directory is the reproducible source patch for the Chisa Mutagen fork. The
patch applies directly to `github.com/mutagen-io/mutagen@v0.18.1`, and includes all
previous Chisa .2 changes (ignore migration and remote completion handling), the
.3 dynamic Git admission changes, and the .4 Linux writer fence. Apply only this
complete patch to clean upstream; do not apply an older Chisa patch first.

`source-manifest.json` pins the complete patch SHA-256 and LF-normalized before /
after SHA-256 for every modified source file. Generated protobuf sources are
included, so replay does not require protoc or a generator build.

## Replay and test

Use a new destination outside all mapped projects and user profiles:

```powershell
pwsh -File app/ops/mutagen/replay-source.ps1 `
  -UpstreamSource '<read-only Go module cache>/github.com/mutagen-io/mutagen@v0.18.1' `
  -Destination '<task-specific diagnostics>/mutagen-chisa4-replay'
```

On hosts whose PowerShell execution policy disables local scripts, use the
portable Python entry point (Python 3 and Git required):

```powershell
python app/ops/mutagen/replay-source.py --upstream-source '<module cache>/github.com/mutagen-io/mutagen@v0.18.1' --destination '<task diagnostics>/mutagen-chisa4-replay'
```

The replay entry points reject a pre-existing destination, verify every upstream input,
copies the upstream module, applies the patch using `git apply` (the application
workspace itself need not be a Git checkout), and verifies every patched file.
It creates source only. It does not build, replace, package, install, deploy or
start a Mutagen binary.

From the replayed source, with a task-specific GOCACHE:

```powershell
go test ./pkg/synchronization/endpoint/local ./pkg/synchronization/endpoint/remote ./pkg/synchronization ./pkg/mutagen -run '^TestGitPolicy|^TestCompletion' -count=1 -v -timeout 300s
go test ./pkg/synchronization/core/... ./pkg/synchronization/rsync ./pkg/synchronization/endpoint/local/... ./pkg/synchronization/endpoint/remote ./pkg/mutagen -short -count=1 -timeout 300s
```

The first test command includes a genuine 100-second idle-boundary test. Tests
create isolated roots and `MUTAGEN_DATA_DIRECTORY` values beneath their own
temporary directories; no existing daemon, profile or project mapping is used.
The manager integrations use an actual in-process engine/controller and two
real local endpoints. Autonomous convergence tests mutate files / Git and
wait for state/content without manual Flush, Resume or UpdateIgnores.
Injected retry-window tests use Flush to observe an unfinished operation
while a channel blocks the next capture; these verify the cross-layer
retry boundary rather than autonomous convergence.

For regenerating only the protocol bindings, use protoc 28.3 and
protoc-gen-go v1.35.1 on `pkg/synchronization/git_policy.proto` and
`pkg/synchronization/endpoint/remote/protocol.proto`. The generated files are
already in the patch. Before a release, protocol changes require a new exact
engine version and capability review. The .4 source manifest pins 48 changed
files and the complete patch SHA-256; consult the manifest rather than an older
.3 digest. Both test endpoints are built from that exact final source.

## Build and package identity

The packaged .4 engine was built on Windows amd64 with Go 1.27.2. From the
replayed source directory, with that toolchain on PATH and a task-specific
GOCACHE, run:

```powershell
go run scripts/build.go --mode release-slim
.\build\mutagen.exe version
Get-FileHash build\mutagen.exe,build\mutagen-agents.tar.gz -Algorithm SHA256
```

The version command must return `0.18.1-chisa.4`. The script applies the required
`mutagencli` / `mutagenagent` tags, trims source paths and disables cgo for these
cross-compiled targets. Take the Windows CLI and agent bundle from the same build.
The retired desktop resource declaration packaged both root artifacts; the cloud-only build excludes them.

| Packaged artifact | SHA-256 |
|---|---|
| [Windows CLI](../../../mutagen.exe) | `32fb5b2603b34d16c3613fc7ba29268411a877b9b98c7f6409a03cefe31e3c79` |
| [Agent bundle](../../../mutagen-agents.tar.gz) | `31bbb4c0841e171e264001a2ba107e8e07be71932d95b7d3650b182059891674` |

These hashes identify the shipped candidate. The upstream archive builder stores
the current time in tar headers, so a rebuild is not promised to have a
byte-identical compressed archive. Source replay is independently checked by the
[source manifest](source-manifest.json), including the complete patch hash and all
48 changed files. Rebuilding an agent bundle is separate from deploying it or
restarting an installed daemon.

## Contract and fail-closed behavior

The native application requires exact engine version `0.18.1-chisa.4` and includes
`/.chisa-sync-policy/git-v1` in live ignore configuration. The engine strips that
reserved marker before ordinary matching and requires remote capability
`chisa-git-policy-v1` before admitting a dynamic session. Older remote endpoints
cannot silently accept the new policy. An upgraded .4 daemon persists legacy
`chisa-vps-*` sessions as paused before making any endpoint connection; they must
receive the marker through paused exact-session update before resume.

Upgrade first uses the hidden `sync pause --all --chisa-drain` entry point against
an existing daemon. It never auto-starts a daemon, permits only base version
`0.18.1` with the known empty or `chisa.1` through `chisa.4` tags, and grants only
the Pause RPC. Normal commands still require the exact client/daemon version.
After pause acknowledges joined controller work, native code stops the old daemon
and waits for its lifetime OS lock before starting the new daemon and recording
readiness. Unsupported versions or failed pause/stop leave migration incomplete.

Each cycle obtains fresh candidate evidence from both endpoints and verifies
their full content witnesses. When candidates, index or policy evidence changes,
it adds archive paths, asks both Git instances about the union in NUL-delimited
batches, then installs one immutable joint admission set. Either index's tracked file overrides either
endpoint's Git ignores, while fixed credential/VCS/dependency/runtime exclusions
always win. New paths appearing after capture are untracked until the next cycle.
Unknown paths are never admitted from stale rules. Ancestor coverage is projected
before reconciliation, preserving peer copies when paths become ignored.

Semantic Git evaluation can be reused only when the candidate set and the full
content-hashed policy witness remain identical. Policy dependency discovery is
performed twice and bracketed around evaluation. Witnesses include the Git index
and shared index, effective config origins/includes/default files, global and
info excludes, relevant nested ignore files, HEAD/admin identity, and relevant
configuration environment. Scan, staging, supplying and transition entry points
validate the witness. Lock files, repository identity changes, invalid Git output,
unsupported include path expansion or policy files above 64 MiB fail closed.
Ordinary file-only roots and selected subtrees retain ordinary static matching.

Warm candidate enumeration asks Git only for fresh untracked paths; the exact
tracked set may be reused only after the complete witness is checked before and
after that enumeration. Compact capture acknowledgements bind the candidate
content token, current installed evaluation token and joint admission hash.
A controller-local cache reuses the immutable joint set only when both endpoints
prove that exact installed generation and every archive path, entry kind and
child name is unchanged. Digest, executable-bit and symlink-target-only
changes may reuse policy; projection always uses the current archive tree.
New/deleted/renamed paths or kind changes force full joint admission.
Scan and all transfer gates still verify current policy evidence.

Coherent policy-content changes and index/config locks before any transfer use
an explicit typed retry: the controller discards the attempt's scans and coverage
projection, waits with cancellation support, and repeats joint admission on the
same endpoints. While a typed coherent retry is pending, state remains
waiting-for-rescan and LastError is cleared; the diagnostic reason is
logged. Native observers must wait for successful fresh admission and
convergence instead of treating that retry as a terminal failure.
Repository identity, malformed configuration, I/O and transport
failures retain normal hard failure handling. Stage/Supply/Transition failures
never use the pre-transfer retry path.

Recursive notifications are acceleration hints. The endpoint policy poll also
wakes independently, so index-only edits, external global excludes and missed
file events converge without an explicit native sync call. Idle polling still
performs bounded Git candidate captures; this is recorded overhead, not a claim
of zero background work. On Linux, recursive inotify supports verified local
ext4/xfs/btrfs/tmpfs trees without extra capabilities. Unsupported filesystems
fall back to polling. Queue overflow, root identity loss, registration failures
or watch-budget exhaustion invalidate acceleration and require a full baseline.

## Linux writer fence and recovery

A dynamic remote endpoint must advertise `chisa-writer-gate-v1` from its actual
initialized Linux gate. A bridge file alone cannot satisfy this requirement.
The endpoint requires an existing canonical root with no symlink ancestors.
Its sibling `.chisa-writer.guard` is a permanent BSD `flock` inode; all native
scans, supplying, staging and transitions acquire it. Native lease mutations and
remote Git jobs acquire writer guard before lease guard, with a bounded deadline.
The lease must be absent or belong to the exact sync epoch with no cleanup/job
reservation. JSON errors, unsafe file types, hardlinks and changed identities deny
admission. The native side never kills a legacy agent: it refuses activation while
a same-UID agent at a known old installation path has validated synchronizer argv.
Because that argv has no root identity, this check conservatively blocks the account.

Initial enrollment is dirty. A nonempty transition persists a new dirty token
before touching files; an empty transition preserves its generation. Completion
requires a fresh full scan, an empty conflict-free reconciliation, no scan errors,
and a generation compare-and-swap. A cloud-owned dirty generation is never cleared
by native recovery. Presence of sibling `.chisa-integration.json`, including
malformed content, blocks initialization, scans, completion, lease recovery and
sync-job admission. Only exact server-side integration recovery retires this marker.
Remote Git jobs hold the writer guard until their actual process group is stopped
and verified; a timeout leaves its recovery reservation in place.

An enrolled root with a missing guard or generation is rejected. Guard inodes are
never unlinked by these workers. This is cooperative fencing, not protection from
an actor with permission to replace the entire root or metadata directory. One
remaining bootstrap window is the interval between the first metadata-absence
check and guard creation: an outside actor could publish metadata and remove the
original guard during that interval. There is no durable guard inode identity in
the current protocol, so that adversarial race is not claimed to be prevented.

## Git and cross-platform behavior

The supported product path is a Windows local replica with a Linux cloud agent.
The release-slim archive also includes macOS, FreeBSD and Windows agents for
upstream uses; they do not advertise the Linux writer gate and cannot serve as the
dynamic cloud endpoint. Cross-compiling those targets is not a claim of runtime
validation on those operating systems. Canonical mapped roots must already exist.

Worktree bytes use two-way-safe reconciliation. Concurrent edits of the same path
can require conflict resolution; synchronization does not choose a losing side.
VCS metadata is excluded from file transfer. The native Git handoff separately
moves the selected HEAD/branch, staged tree (or explicit conflict stages 0–3),
required objects and supported merge/rebase/cherry-pick operation state under a
checkpoint and compare-and-swap. It reconstructs the receiving index without
checking out worktree bytes. Staged blob/mode/path and unmerged-stage semantics are
preserved; byte-identical index files, stat caches, extensions, assume-unchanged,
skip-worktree and intent-to-add flags are not a portable replication guarantee.
AI delta integration has its own journal and preserves the target index; that is
separate from an explicitly requested native Git state handoff.

One changed Git state since the checkpoint can be handed to the other replica.
If both endpoints independently change HEAD, branch, index or operation state,
native handoff stops and preserves both. On first handoff, an ambiguous branch or
staging direction also stops. It does not merge unrelated branch histories or
switch over a branch in use by another linked worktree. Only the selected branch
and necessary object history are coordinated, not every local branch, remote ref
or repository configuration setting. Recovery commits under private recovery refs
are internal safety snapshots; synchronization does not create a user branch commit.

Windows checkout bytes are retained. Cloud Git uses `core.autocrlf=input`,
`core.filemode=false`, and `core.symlinks=false`. A Git mode `120000` index entry can
be retained while a Windows checkout represents it as a regular link-target text
file; this does not make it a working Linux filesystem symlink. Actual symlink
creation on Windows needs the OS privilege/developer-mode support, and portable
link-target restrictions still apply. Permission bits, case-colliding paths,
Windows-reserved names and Linux-only filesystem semantics cannot be promised
identical across both replicas. Executable modes recorded in Git are distinct from
Windows filesystem permission bits. Dependencies, credentials and fixed runtime
exclusions remain excluded even when force-tracked; ignored content may need to be
installed or supplied independently for execution on the cloud host.

## .4 verification scope

The Windows desktop full run `go test . ./cmd/sync-ssh -count=1 -timeout=1800s`
passed before the final migration-only change: 863 test/subtest pass events,
6 explicit environment/opt-in skips, and both packages passed (desktop 1092.059s;
SSH wrapper 4.044s). After the final change and packaging, all 21 affected
transport/pause/wrapper test/subtest events passed (desktop 38.911s; SSH wrapper
2.618s), including a real old `.2` daemon with actual synchronized files.
A separate real `.3` daemon migration passed in 10.690s. Both use private daemon
profiles and verify no auto-start on drain, ordinary version mismatch rejection,
paused old-controller acknowledgment, full restart, preserved session/files and
exact readiness. No installed or user daemon is exercised by these tests.
The final source patch replays and its migration command tests pass. The
`release-slim` engine build, plain native `go build`, and Windows SSH wrapper build
succeeded. The plain native verification executable is not a frontend-embedded
installer; creating a release installer is a separate operation.

This revision was exercised with real Linux file locks and process groups under
WSL, actual local/remote policy RPC, controller convergence/retry tests, and the
Windows desktop Git/lease/transport regressions. The Linux core filesystem suite
passes. The Windows core symlink cases cannot run without link-creation privileges;
this is an environment limit, not a passing Windows symlink result. No live VPS
was deployed or diagnosed for this .4 release. The historical measurements below
belong to the earlier .3 work and do not measure .4 locking overhead or current WAN
performance.

## Historical .3 verification scope

The source regression covers absent-at-startup `*.log`, force-add in only one
index, ignored ancestors and sibling isolation, .gitignore edits, rename into and
out of ignored coverage, unknown candidates after capture, stale scan/supply
admission, external index locks, fixed security exclusions, same-size/same-time
ignore edits, absent config include creation, administrative directory replacement,
bounded metadata reads, actual remote policy RPC, and autonomous local controller
convergence. Additional regressions cover compact capture generations, partial
installation invalidation, coherent retry without reconnection, immutable-tree
cache invalidation, entry-limit growth and newly divergent conflicts. Linux
watcher tests ran as UID 1000 with zero effective capabilities.

The canonical40 baseline task benchmark used two independent real Git roots with 37,000 source
files and 4,096 ignored files per endpoint, 20 consecutive saves, and 105 seconds
idle. Both Windows and the real Linux VPS ran a controller plus two **local**
endpoints in one Go process. These figures do not describe a single SSH agent or
Windows-to-VPS network latency:

| Host | Cold canary | Save p50 / p95 | Idle Go CPU, one core | Idle Git commands / output |
|---|---:|---:|---:|---:|
| Windows baseline | 14.844 s | 2.016 / 2.826 s | 23.26% | 224 / 140.9 MB |
| Windows final | 13.073 s | 1.686 / 1.789 s | 10.26% | 66 / 1,056 B |
| Linux baseline | 1.435 s | 1.065 / 1.414 s | 56.84% | 344 / 216.4 MB |
| Linux final | 1.896 s | 0.592 / 0.720 s | 4.54% | 100 / 1,600 B |

Linux final process plus measured Git child CPU was approximately 6.97% of one
core, compared with 59.99% at baseline. Windows Git wrapper CPU is only a lower
bound and is reported separately in the diagnostic evidence. Windows final idle
RSS was 244.1 to 231.8 MB; Linux was 197.6 to 182.8 MB. Both final runs passed
post-idle create/rename/force-add/delete/ignored-sibling checks and retained exactly
two endpoint connections. The early Windows baseline's extra reconnection was
preserved as a measured failure and repaired with coherent policy retry.

Raw phases, resource samples, source hashes and limitations are documented in
`diagnostics/sync-vps-e2e-20261021/bench/task5-progress.md`. Real SSH/native complete
chain and WAN-scale validation are tracked separately by the Team Lead. No real
user project, installed engine, release installer or deployment is changed by
these source and diagnostic tool operations.

## Measured WAN archive-shape and retry-state promotion

A fresh owned 37,000-file Windows-to-SSH/Linux run passed 20 automatic
saves, at least 105 seconds idle, content inventory and post-idle
force-track/rename/delete/ignored isolation checks using the exact
reviewed candidate CLI and agent. Save latency includes the observer ACK:

| Run | Save p50 | Save p95 |
|---|---:|---:|
| Frozen canonical40 WAN baseline | 6.321 s | 6.381 s |
| Archive-shape candidate | 3.281 s | 3.464 s |

Raw candidate evidence: `diagnostics/sync-vps-e2e-20261021/final-scale/wan-shape-v2-evidence.json`. The candidate
changes only four reviewed policy/controller source/test files. Complete content
witnesses, fresh captures and installed/admission generation checks remain;
this improvement is not based on a TTL or stale snapshot. Network saves
still have visible latency. These WAN figures must not be substituted
for the separate local-endpoint benchmark above. Previous canonical
source and patch are retained only in task diagnostics.

Native cold import was 125.430 s at baseline
and 130.481 s in this candidate run;
this includes real Git preflight and first transfer, with seeding separate.
Remote agent idle CPU was 1.1801%
versus 1.7249% of one core.
Windows CPU is recorded per owned process (JSON below); these samples
exclude unknown Git/SSH descendants and cannot be called total host CPU.
Any slower cold import or higher background CPU remains a limitation;
the warm-save improvement is not a claim that every metric improves.

Baseline Windows process CPU: `[{"cpuPercentOneCore": 0.05762396214484437, "exe": "C:\\Users\\48818\\AppData\\Local\\Temp\\go-build4230761522\\b001\\app.test.exe", "pid": 31312, "workingSetBytes": 84762624}, {"cpuPercentOneCore": 3.7455575394148846, "exe": "C:\\Users\\48818\\AppData\\Local\\Temp\\TestVPSProductLargeRepositoryPerformance2365939564\\001\\resources\\mutagen.exe", "pid": 10628, "workingSetBytes": 193024000}, {"cpuPercentOneCore": 0.043217971608633284, "exe": "C:\\Users\\48818\\AppData\\Local\\Temp\\TestVPSProductLargeRepositoryPerformance2365939564\\001\\resources\\mutagen.exe", "pid": 40080, "workingSetBytes": 22347776}]`.

Candidate Windows process CPU: `[{"cpuPercentOneCore": 0.05734514565038493, "exe": "C:\\Users\\48818\\AppData\\Local\\Temp\\go-build4086919461\\b001\\app.test.exe", "pid": 20456, "workingSetBytes": 83324928}, {"cpuPercentOneCore": 5.433452550373972, "exe": "C:\\Users\\48818\\AppData\\Local\\Temp\\TestVPSProductLargeRepositoryPerformance1628227575\\001\\resources\\mutagen.exe", "pid": 23468, "workingSetBytes": 258105344}, {"cpuPercentOneCore": 0.11469029130076985, "exe": "C:\\Users\\48818\\AppData\\Local\\Temp\\TestVPSProductLargeRepositoryPerformance1628227575\\001\\resources\\mutagen.exe", "pid": 23512, "workingSetBytes": 21434368}]`.

The earlier archive-shape-only WAN run failed its native safety handoff
and remains failed evidence. Only this successful v2 run supports promotion.

The isolated 100-second idle test observed ten small local saves with p50 1015 ms
and p95 1270 ms, two endpoint connections throughout, 145 captures, 144 evaluations,
144 scans and 72 completed cycles over 114.49 seconds. These are fixture
measurements on this Windows machine, not a network or large-project latency
promise. Evaluation RPC count is not the number of spawned Git processes; unchanged
semantic policy answers are reused under the content witness.
