# ChisaCloudCode synchronization runtime

ChisaCloudCode requires **Mutagen 0.18.1-chisa.2**, based on the pinned public `github.com/mutagen-io/mutagen@v0.18.1` module. The exact upstream tag, module checksum, changed paths and patch checksum are in `SOURCE.json`; the upstream license is retained in `LICENSE.upstream`.

The cumulative patch contains the half-open completion protocol fix and regression tests, Linux synchronization-agent stdio handling, and archive-preserving ignore updates. It includes every added file and test. Only the Windows amd64 CLI and Linux amd64 agent are built for this desktop deployment. The numeric protocol version remains 0.18.1; the tagged identity gives the customized agent its own installation directory.

## Rebuild

Use Windows, Git and **Go 1.27.1**:

```powershell
./ops/mutagen/build.ps1 -Go C:/path/to/go1.27.1/bin/go.exe -OutputDirectory C:/build/chisa-mutagen
```

The script verifies the pinned Go module checksum, applies the cumulative patch, runs completion and ignore-update regressions, and invokes `go run scripts/build.go --mode slim`. It does not use `--sspl`; SSPL enhancements are not enabled. The resulting engine, agents archive and generated integrity manifest belong together.

The source archive distributed with a release contains the same patched source and all regression tests. The build does not normalize archive times or build paths, so a later rebuild can produce different byte hashes. `runtime-dependencies.json` at the product root records the exact previously tested runtime files shipped in this release; compare downloaded files to those values. A rebuild has its own generated checksum manifest.

## Ignore updates

```powershell
mutagen sync pause <identifier>
mutagen sync update-ignores --configuration-file <yaml> <identifier>
mutagen sync resume <identifier>
mutagen sync flush <identifier>
```

The command accepts one complete session identifier, requires its synchronization loop to be paused and stopped, validates rules, and atomically changes only the ignore configuration. It preserves the synchronization archive. The next cycle projects the ancestor onto the new coverage before reconciliation so newly excluded entries cannot become propagated deletions; still-covered entries retain their baseline. This operation does not resume the session itself.

The application uses it only when effective policy changes. Normal message handoffs retain the active watcher and cached observations.

Runtime compilation never stops an installed daemon or changes a deployed server. Activation and deployment remain separate application operations with active-task and ownership checks.
