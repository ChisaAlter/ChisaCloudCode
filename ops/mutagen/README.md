# ChisaCloudCode synchronization engine sources

This directory preserves the historical **Mutagen 0.18.1-chisa.3** source and
the dynamic Git policy capability `chisa-git-policy-v1` from the VPS sync lifecycle
branch. The current cloud/SSH desktop does not bundle or start this synchronization
engine. These recipes support source provenance and historical reproduction;
merging them does not publish or replace an engine binary or installer.

The product-root `runtime-dependencies.json`, `SOURCE.json` in this directory,
`build.ps1` and `chisa-0.18.1-chisa.2.patch` describe the previously released .2
runtime. Their historical checksums remain unchanged. A .2 runtime cannot satisfy
the historical .3 native version check. Reproducing that retired native application
requires a .3 build from the recipe below; do not substitute upstream Mutagen or
reuse .2 release files with a changed version label.

## Exact .3 source replay

The .3 recipe applies directly to `github.com/mutagen-io/mutagen@v0.18.1`;
**do not apply the .2 patch first**. It contains the completion, Linux stdio and
archive-preserving ignore changes, plus dynamic Git policy and regression tests.
It does not inherit the old .2 release's modifications to the upstream build
script. The new Python recipe selects the two supported platforms directly.

`source-manifest.json` pins LF-normalized before/after hashes for all 40 changed
paths and this patch SHA256:

```text
ae78c79c2557ab884a1cb59fc2210a3d719b8c9ae118e7e164588b3ff648c09f
```

With Python 3, Git and a pristine copy of the pinned Go module:

```powershell
python ops/mutagen/replay-source.py --upstream-source '<module-cache>/github.com/mutagen-io/mutagen@v0.18.1' --destination '<new-output>/source'
```

The replay rejects an existing destination, verifies upstream input and patch
hashes, checks/applies the patch, and verifies every output hash. Generated
protobuf files are included; replay does not need protoc, compile or start an
engine. The PowerShell counterpart accepts `-UpstreamSource` and `-Destination`.

## Build .3 explicitly

Use Go **1.27.1**, Python 3 and Git. Select a new output directory outside mapped
projects and profiles:

```powershell
python ops/mutagen/build.py --go '<path-to-go>' --output '<new-output>/chisa3'
```

The recipe verifies the upstream module checksum, replays the exact patch, runs
policy/completion regressions, and compiles a Windows amd64 CLI and Linux amd64
agent with CGO disabled, explicit build tags and `-trimpath`. The agents archive
contains exactly `linux_amd64`; its extracted bytes are checked against the
compiled agent. No SSPL enhancements are enabled. The result includes
`mutagen.exe`, `mutagen-agents.tar.gz` and a **new local integrity manifest**.
Copy the two runtime files to the product root only as part of a deliberate local
activation. This recipe never installs, deploys, activates a daemon or produces a
release installer. `--skip-tests` is available for compile-only checks and is
recorded explicitly in the generated manifest.

The source publication was validated by replaying into two clean destinations;
all 825 files matched the source used for the measured .3 candidate. Binary
checksums depend on the chosen build/toolchain and archive recipe. The retained
.2 release manifest is not a checksum manifest for these new build outputs.

## Admission and handback contract

Each dynamic cycle captures fresh evidence at both endpoints, verifies complete
content witnesses, evaluates the candidate union in NUL-delimited batches and
installs joint admission. Either Git index's tracked paths override Git ignore
rules, while fixed credential/VCS/dependency/runtime exclusions always win.
Unknown paths wait for a new cycle. Ancestor projection uses current archive
content so ignore changes cannot become unintended propagated deletions.

Semantic policy reuse requires identical candidate evidence and full witnesses.
The archive optimization compares every path, child name and entry kind; content,
executable-bit and symlink-target changes alone can reuse the matching rules.
New, deleted, renamed or differently typed paths require joint admission again.
Captures, installed/admission generations and scan/transfer validation remain
fresh. There is no TTL or stale-snapshot authorization.

Witnesses cover Git indexes, shared indexes, effective config/includes, ignore
files, repository/admin identity and relevant environment. Unsupported or
malformed inputs, overlarge policy files, identity changes, transport failures
and hard I/O errors retain their safety barriers. Coherent pre-transfer changes
retry on the same endpoints, remain `waiting-for-rescan`, and log the reason
without exposing a fatal `LastError`. Native callers still wait for a newly
confirmed successful cycle before handback. Conflicts, foreign locks, root
clearing and unknown process/container cleanup do not become success.

For additional engine tests in a replayed source tree:

```powershell
go test ./pkg/synchronization ./pkg/synchronization/endpoint/local ./pkg/synchronization/endpoint/remote -run '^TestGitPolicy|^TestCompletion' -short -count=1 -timeout=300s
```

Removing `-short` includes the real 100-second idle-boundary integration. Tests
use private roots/data directories. Autonomous convergence tests mutate files or
Git and wait for results; injected retry-window tests deliberately hold the next
capture and use Flush to verify that unfinished admission cannot complete.

See [the sanitized acceptance report](../../docs/validation/vps-sync-lifecycle.md)
for measured benefits, cold-start/CPU/RSS regressions and validation boundaries.
