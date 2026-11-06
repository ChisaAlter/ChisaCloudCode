# Chisa W01/W16 recovery candidate

Status: reviewable candidate, not installed. Production G1 is **not passed**. No production writer was stopped, no unit was enabled, no production backup or restore was performed. All executable write tests use temporary fake data. The source/lock/product scope is untouched by this work.

`recovery.py` uses Python 3.11+ standard library and an existing GPG executable. Production uses Linux, Docker read-only inspection, systemctl read-only inspection, findmnt, losetup, OpenSSH SFTP and unshare/mount. No package manager or dependency change is required to review or run tests. GPG public keys must be preprovisioned; the recovery private key must be held on a separate recovery host.

## Commands and exit contract

```text
python3 -B recovery.py preflight --config /etc/chisa-recovery/config.json
python3 -B recovery.py backup --config /etc/chisa-recovery/config.json
python3 -B recovery.py monitor --config /etc/chisa-recovery/config.json
python3 -B recovery.py fetch --config /etc/chisa-recovery/config.json
python3 -B recovery.py verify --config /etc/chisa-recovery/config.json
```

All these commands are read-only by default. `preflight` and `monitor` never write status files or run GPG. They read the SQLite header/WAL existence only, because opening a live WAL database with a read-only SQLite connection can still create SHM files. Integrity and relational counts are checked only in fenced backup and isolated copies. Exit 0 means that command's checks completed; exit 2 means a missing/failed gate. `verify` returning 0 proves stored file/SQLite consistency only; its result always has `production_drill_passed=false` until separate application/operator evidence exists. No command auto-repairs admission, lease, mount, service or firewall state.

Explicit write actions, after independent review and appropriate maintenance authorization:

```text
python3 -B recovery.py backup --config /etc/chisa-recovery/config.json --execute
python3 -B recovery.py fetch --config /etc/chisa-recovery/recovery-host.json --bundle-id RECORDED_ID --target /var/lib/chisa-recovery/isolated-restores/download/bundle.tar.gpg --expect-sha256 INDEPENDENT_RECEIPT_DIGEST --execute
python3 -B recovery.py verify --config /etc/chisa-recovery/recovery-host.json --bundle /var/lib/chisa-recovery/isolated-restores/download/bundle.tar.gpg --target /var/lib/chisa-recovery/isolated-restores/drill-UNIQUE --expect-sha256 INDEPENDENT_RECEIPT_DIGEST --key-home /secure/off-source-recovery-keyring --execute
```

`fetch` downloads only a remotely committed recovery point, verifies the independent ciphertext digest and refuses an existing target. `verify` requires a fresh target below `restore_root` and a different machine from the manifest. It executes a new Linux network + mount + PID namespace, hides `/run` (including Docker/containerd sockets), verifies that only loopback exists and no network route exists, uses a minimal environment, decrypts offline and never starts a service, provider, callback or restored script. Run the recovery host without production write credentials. Network namespace isolation is a defense for verification, not authorization to run unreviewed user code. Application smoke is a separately gated operation in that environment with substitute credentials/test endpoints.

The program does not perform in-place restore or automatically copy data back over production. A failed verification leaves a private `FAILED.json` marker; a successful one writes `verification.json` and a private manifest in the new target. Restore is a data recovery decision, not a code rollback shortcut.

## Consistency protocol and writer evidence

The implementation intentionally uses a cold, externally fenced full file-level copy. Under that fence it copies the source SQLite database plus WAL/rollback journal to private staging, checks unchanged source bytes before/after, and runs SQLite `Connection.backup` on the staged input. This includes committed WAL pages without opening SQLite against production or creating production SHM. Raw `auth.db`, WAL, SHM and rollback-journal files are excluded from the published file copy and replaced by the API snapshot in `payload/_sqlite/database.sqlite`. File content + modes + UID/GID + mtime + xattrs are recorded inside the encrypted manifest; files are hashed again across capture. A changed inventory, content, mount or fence aborts publication. The loop image itself is never copied while mounted/writable; the verified file-level workspace tree is the selected backup method.

Before `backup --execute`, an authorized operator/supervisor must close admission and fence **api, worker, agent, shell, preview, legacy_sync, scheduled and host_manual** writers. The tool only checks evidence and observed state; it never stops or kills anything. Use `fence.example.json` only as a denied template. Required evidence is fresh, root-owned 0600, bound to machine-id digest and boot-id, with a reviewed maintenance ID and expiration. All configured writer services/timers must be inactive and runtime-masked/masked. Docker is enumerated by immutable IDs; every container with a writable bind/volume overlapping any source must be stopped with PID 0 and restart policy `no`. This includes stopped historical API containers that could otherwise restart. Docker timeout/inspect failure is a failure, not evidence of absence.

A host `/proc` scan checks cwd, writable FDs and writable shared mmap paths under every covered root. Permission errors fail closed. This scan is a conservative supplement to the admission fence and reviewed scheduler/admin inventory. It cannot prevent a privileged operator from starting a new writer after a scan; therefore an external maintenance lock/fencing contract is mandatory, and it is rechecked before capture, after capture and before publication. Unknown writer/supervisor coverage blocks the window. Short-lived fence evidence must be refreshed by the authorized coordinator if a large transfer exceeds its expiration; do not lengthen it blindly.

The API and old sync systemd services currently both have `Restart=always`. Docker `restart=no` for sync alone does not fence it. The candidate hourly timer does not implement drain/mask and will fail without a current maintenance fence. Automated hourly RPO is **not established** by installing a timer; either schedule approved brief complete drain windows or implement and prove durable writer fencing/snapshot coordination before enabling unattended success claims.

## Covered state and secret handling

`config.example.json` records the observed production paths and UUID, and deliberately leaves offsite/key/retention credentials unconfigured:

- SQLite + all other files in the data directory, including existing DB-only manual copies.
- Entire workspace tree including Git objects/worktrees and `.chisa*` runtime data, without arbitrary exclusions.
- Entire persistent HOME, including `.chisa-workspace-runtime`, preview witnesses/leases/generation, `.chisa-workspace-sync`, provider/session data, SSH trust and `.cloudcli/assets` attachments.
- Deployment directory, secrets directory, exact API/sync/mount units and the required host SSH trust file. Deployment configuration may itself contain credentials, so every source is treated as sensitive.
- Effective JWT `environment` source is checked by in-memory equality against the covered private `/opt/chisacloudcode/secrets/api.env`; neither the value nor its hash is printed. Database-source JWT is intentionally blocked as requiring a newly reviewed credential-source configuration.

The offsite recovery private key/passphrase must never enter these sources. GPG backup uses an initialized public-only keyring outside the sources; preflight rejects private-key files, execute additionally checks GPG secret-key inventory. Temporary plaintext staging is 0700 under a private spool and removed on completion/failure. Host crash/power-loss can leave `.plaintext-*` directories; they contain sensitive data. Operators must inspect stale entries, confirm there is no running lock holder and follow the host's secure media policy; ordinary deletion is not guaranteed forensic erasure. Use encrypted backing storage and never publish plaintext staging.

Public receipts and journal stdout contain only aggregate counts, timestamps, public recipient identity, ciphertext size/hash and gate codes. Raw paths, per-file hashes, SQL row values, env values and secret hashes stay out of public receipts. The full manifest is inside the encrypted tar, and the restored manifest is private. All configured exclusions require a reason; required coverage roots cannot be excluded. Tests use a nonsecret canary to prove optional transient exclusion and absence of secret values from receipts/ciphertext plaintext scans. Required real secrets are encrypted and restored; they are not silently omitted.

Symlinks that remain within a source are represented without following them, then restored last after extraction. Absolute/escaping links, hardlinked regular files and special files (sockets/devices/FIFO) fail the entire snapshot; they are never followed or skipped silently. Hardlinks require an independently verified snapshot/link-preservation extension; copying them as independent files could violate the runtime's single-link identity checks. If HOME contains legitimate transient sockets or deployment external links, inventory them in a fenced fixture, add explicit reviewed narrow exclusions or convert them to separately covered source roots, and revalidate required state. Do not exclude all hidden files, leases, Git or credential data to get a green check.

Verification records UID/GID/ACL/xattrs but does not apply active ownership/capabilities/ACLs on the recovery host. It applies ordinary permission bits without setuid/setgid. Promotion therefore remains blocked until an approved same-path/UID/GID/ACL/xattr mapping and generation/old-writer fencing reconciliation is tested. Never activate the restored lease files as permission to take over.

## Encryption, offsite and retention

Production metadata proved GPG/OpenSSL/OpenSSH available; age/restic/borg/rclone were absent. This candidate uses GPG recipient encryption instead of inventing an endpoint or installing software. Supply a public fingerprint from the independent recovery custodian, a reviewed public keyring and SHA256-pinned `recovery-key-evidence.example.json` showing offline decrypt-challenge success. The private key remains off the backup host.

Offsite SFTP always uses `BatchMode=yes`, `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, a pinned known-hosts file and a dedicated SSH identity. It creates unique recovery-point directories, uploads encrypted bytes, downloads all ciphertext and compares SHA256, then rechecks fence/mount before writing and reading back `COMMITTED.json`. No completed marker means incomplete upload. No success record is emitted on transfer/readback failure. There is no remote delete/prune operation.

SFTP alone cannot prove WORM/retention or physical host independence. Supply destination identity/storage/failure-domain evidence and independently verified append-only or immutable history with separate retention administration. `retention-evidence.example.json` is a denied template, pinned by SHA256 after real validation. The initial retention policy is 48 hourly, 30 daily and 12 monthly points; actual endpoint enforcement, restore read access and delete-denial must be exercised independently. The source write credential must not be capable of deleting all history. A self-edited JSON boolean is not evidence of those tests.

The example omits shared `/opt/letsencrypt` certificate private state and OCI image export because their ownership, shared service implications and recovery access require Lead/shared-host inventory. Valid source/image digest and certificate renewal/reissue plan belong in the release/recovery evidence before G1. Do not recursively absorb another project's storage into this backup without ownership review.

## Tests and evidence

Windows PowerShell (existing Git GPG only; no Bash shell used):

```powershell
$env:CHISA_TEST_GPG = 'C:\Program Files\Git\usr\bin\gpg.exe'
python -B -m unittest discover -s ops/recovery/tests -v
$testExit = $LASTEXITCODE
exit $testExit
```

Use an actual Python 3.11+ executable, not the Windows Store alias. A clean log/JSON runner is available at `tests/run_tests.py --log <existing-evidence-directory>/fixture-tests.log --result <existing-evidence-directory>/fixture-result.json`. It records source SHA256, euid, the full unittest output, exact pass/failure/error/skip counts and exit. If local signing policy rejects a `.ps1` wrapper, do not change policy; invoke this Python runner directly. Tests create real temporary GPG keys and fake databases/files only. Local `--fixture` mode bypasses namespaces strictly under an OS temp directory; fixture `verify --execute` without `--fixture` instead exercises the real namespace route, still permanently labelled test-only/nonproduction. Production still requires a recorded different source machine identity; missing identity fails closed.

Linux production prerequisites must use a root suite: its fence uses actual euid=0 and real inode owner, and its POSIX permission/foreign-owner/symlink negatives use real chmod/chown/symlink. A nonroot unit run models euid=0 and only the exact fixture fence inode's st_uid together, retaining the real inode/device/mode and symlink/private-path implementation. It explicitly verifies a real 0644 fence is rejected before target gates. The root-only chown negative is skipped in nonroot runs, so those counts must never be reported as all tests passed. Windows skips POSIX-only negatives. Neither nonroot mocks nor Windows fake metadata establish Linux production prerequisites.

A separate root Linux integration harness is `python3 -B tests/namespace_challenge.py --log <existing-evidence-directory>/linux-namespace-challenge.log --result <existing-evidence-directory>/linux-namespace-challenge.json`. It creates full-scope fake encrypted data and ephemeral test keys, verifies COMMITTED/fetch, exercises the actual CLI namespace restore, checks distinct net/mount/PID namespaces and private `/proc`, hides `/run` sockets, and proves IPv4/IPv6 no-egress before/after trusted fake business operations. Those operations inspect DB relations/Git/attachments/lease/config/modes and run a fixed trusted shell, namespace-loopback preview authorization/cancel and a fake child crash. It never executes restored code or the product/provider, and always reports `production_drill_passed=false` and `production_offsite=false`. The 2026-11-01 WSL run is recorded in W01 evidence. Real systemd fencing/Docker/SFTP endpoint integration, real application smoke and production offsite recovery remain unproven.

## W16 candidate

`monitor` emits read-only JSON and exit 2 for missing/stale consistent offsite point, last failed attempt, absent/current successful production-drill evidence, missing mount/SQLite header, capacity/inodes, required systemd unit missing/failed/inactive, empty Docker observation/no running relevant container, Docker OOM/restarting/dead/unhealthy and a certificate at seven days or less. Certificate 30/14-day thresholds and unbounded logs warn. Docker observations are separate from systemd restart counters; historical stopped containers alone do not imply an outage. `/var/run/reboot-required` is reported without patching/rebooting. Fixture profile can never return production `stateful_change_ready=true`.

Missing exporter or alert routing explicitly blocks readiness and exits 2 (`MONITOR_EXPORTER_EVIDENCE_REQUIRED`, `MONITOR_ALERT_SINK_EVIDENCE_REQUIRED`). `monitor.exporter` and `monitor.alert_sink` require an existing private, SHA256-pinned local evidence record. Records use version=1, kind=exporter/alert_sink, healthy=true, checked_at with timezone, current machine/boot identity, and an evidence_reference to a separately reviewed real test. Freshness defaults to 24 hours. Exporter must attest covered_signals for request_latency/authentication/websocket/lease/cleanup. Alert sink must attest delivery_test_passed=true and independent_receiver_confirmed=true. Missing/hash-mismatched/stale/unhealthy/wrong-host/incomplete records fail closed. These are dependency attestations; this CLI does not implement exporters or send alerts, and editing JSON cannot substitute for an actual delivery/observation test. The example deliberately leaves both inputs null.

The systemd candidates are not installed or enabled. Review with `systemd-analyze verify` in an isolated Linux deployment layout before enabling. They require the workspace mount before backup and use private permissions/read-only source paths. Monitor runs every five minutes, backup attempt hourly. No exporter or notification destination was supplied; connect a reviewed OnFailure/journal route and exercise independently confirmed delivery before writing the pinned evidence. Product/broker owners must supply real request/auth/WS/lease/cleanup/p95 metrics and freshness evidence. Main production patch/restart remains a separate G1-gated change.
