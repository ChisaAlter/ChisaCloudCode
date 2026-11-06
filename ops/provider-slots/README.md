# Fixed provider slots (candidate, no production deployment)

This is the completed fixed-slot consumer/preparation stage. It is **not the automatic multiple-run publisher**. API callers cannot register paths, copy host credentials into broker sources, generate signing keys, or rotate a lease. Normal configured provider execution is tested with a real independent slot server, issuer, SQLite and verified W02 bytes. Actual Linux Docker and independently supervised lease publication remain gates.

## Processes and trust

The API reads `CHISA_PROVIDER_SLOT_CLIENT_CONFIG`: root-owned bounded single-link JSON under root-protected parents, `{version:1,socketPath,slots:[<client-slot>]}`. Each slot binds provider/user/owner/app-session/root/workspace/generation/lease/epoch/profile, fixed HOME, complete mount set and executable path. This is a selector. Ordinary broker/issuer client configuration remains separately required. A missing or ambiguous selector rejects before launch.

`slot-supervisor.mjs` runs as a separate root operator service with no Docker socket and no signing key. It reads a private manifest `{version:1,registryDirectory,witnessDirectory,issuerSocketPath,brokerSocketPath,socketPath,clientGroupId?,slots:[<supervisor-slot>]}`. Its private Unix endpoint supports only `POST /v1/prepare` and `/v1/finish`. Socket parent is protected; permission is 0600 or 0660 to the dedicated client group. Do not put the group on a directory writable by the API. No register/enroll/mkdir endpoint exists.

The issuer receives a private enrollment with `providerSlotId` and `providerPreparedDirectory`. It independently reopens the prepared witness for every run/exec grant, validates complete identity/profile and expiry, then issues a <=120second proof. Status/cancel/reconcile remain available before preparation or after its gate so cleanup is possible. The API does not write that witness directory. Run proofs expire no later than either trusted witness.

## Operator artifacts

Compile the application worker using the coordinated normal build. Run the following only in a protected candidate/staging root; do not point these commands at production without the separate deployment gate.

```
node ops/provider-slots/build-code.mjs /etc/chisa/provider-code-build.json
node ops/provider-slots/enroll-slot.mjs /etc/chisa/provider-slot-enroll.json
node ops/provider-slots/slot-supervisor.mjs /etc/chisa/provider-slots.json
```

The code build spec is `{version:1,destination,workerPath,packageFrom,cliSource,cliRelative,nodeExecutable?}`. The worker must be compiled JS. Node plus worker, the installed cross-spawn/Codex SDK dependency closure, and the explicit self-contained CLI tree are copied to a fresh destination. Installed package versions are not fetched or changed. CLI must include its own runtime dependencies; symlinks reject. For a native Codex ELF, use a protected tree containing that binary and select it explicitly. The stage does not assume a Windows native package can run in Linux. Cross-platform/architecture executable verification remains a Linux artifact gate. The API never calls this builder.

Enrollment spec fields:

```
{
  "version":1,
  "slotId":"owner17-sessionA-lease1",
  "provider":"codex",
  "ownerId":"owner17","userId":"17","sessionId":"sessionA",
  "workspaceId":"projectA","generation":"generationA",
  "leaseId":"lease1","bindingEpoch":"epochA","profileId":"providerA",
  "witnessId":"independently-supervised-writerA",
  "root":"/srv/workspaces/projectA",
  "slotParent":"/srv/chisa-provider-slots/owner17",
  "controlledRootId":"provider-owner17",
  "codeSource":"/srv/chisa-code/verified-release",
  "cliRelative":"cli/codex",
  "uid":1000,"assetCount":16,
  "ticket":"<64-128 hex opaque slot ticket>",
  "brokerTicket":"<64-128 hex independent broker ticket>",
  "expiresAt":1800000000000,
  "credentials":[{"source":"/srv/chisa-credentials/owner17/auth.json","relativePath":".codex/auth.json"}],
  "stateImports":[]
}
```

Paths above are examples, never generated enrollment authority. Parent/code/credential namespace must be root-owned and not API/worker-writable. All source trees must be canonical regular files/directories; hardlinks and symlinks reject. Exports contain no credential bytes. Slot/broker tickets are capabilities: private supervisor/issuer fragments are 0600; the client fragment is 0640 for the dedicated API read group. Explicitly set deployment group ownership; no broad chmod or recursive chown is performed.

Enrollment creates a fresh slot directory. It snapshots code/credentials, prepares HOME and exact credential mount placeholders, creates the fixed empty asset files and records their full device/inode as decimal strings. It emits `supervisor-slot.json`, `client-slot.json`, `broker-profile-mounts.json`, `bridge-profile.json`, `issuer-entry.json`. Merge fragments offline into protected full manifests before starting the candidate processes; there is no API configuration writer. Broker profile mount fragment still needs its operator-selected image digest, UID/GID and resource limits, plus the exact Git mounts supplied by the bridge. Its controlled root must belong to the same owner. Bridge profile uses runtime mounts plus the exact current Git mount set. Do not take Git source paths from client transport options.

A later slot of the same owner/user/provider/app-session/root/workspace can specify `persistentHome` pointing at its earlier registered HOME. A root-owned sibling owner record must match all those fields. Every lease has separate credential/asset slot files; HOME may persist across leases, while the workspace broker lease fence controls active execution. A different session/owner cannot share it. The operator must independently prove the prior lease quiescent before allowing a new lease to execute. This stage does not rotate that authority automatically.

HOME leaf and state subdirectories are worker UID owned; their namespace parents remain root protected. API history readers need a separate read-only ACL or group policy on that HOME (including native CLI-created files). Do not grant API/worker write permission to its source parent. The same absolute catalog paths must be visible to broker, supervisor and API; container remapping cannot silently change a source identity.

## Byte and cleanup lifetime

The API calls the public W02 reader with authenticated owner immediately before preparation and passes verified bytes plus digest. Original upload paths are labels only and never mounts. Maximum 32 assets, 25MiB/file and 32MiB aggregate. The supervisor validates all selectors against its private manifest and independently requests issuer status, persists a SQLite FULL-synchronous `pending` record, then writes only already registered file inodes. An interrupted pending preparation is uncertain forever until operator reconciliation. It never rewrites different bytes on retry. Completed preparation seals every slot file (unused files empty), publishes the root-owned witness and permits only identical digest replay.

`finish` never resets a slot, clears assets, imports credentials back, or publishes new source paths. Confirmed finish asks the issuer for a narrowly profiled status proof and asks the broker itself for the exact operation. Profile/workspace/generation/lease/immutable resource and cleanupConfirmed must all match. A failure retains the immutable seal. API booleans never release a writer or authorize a new lease. Existing bridge two-phase immutable Git publication happens only after daemon absence and its original CAS checks.

Provider jobs map cwd/threadOptions.workingDirectory/CLI `--dir`/`--cwd` and exact verified image paths to `/workspace` or `/runtime/provider-assets/attachment-N`. Unmapped Codex local_image rejects. Worker HOME/PATH/TMPDIR and provider credential environment are operator profile values; API process.env keys are not copied. The entry point preserves cancellation, delayed session assertActive checks, ordered stream frames and confirmed cleanup.

## Automatic publisher critical path (next stage, not complete)

The existing legacy lease file is API-written and is not independent enrollment authority. An automatic publisher must own an independent writer fence and select the new lease itself from protected binding/session supervision, preserve durable identity/alias tombstones, query exact prior broker quiescence before rotation, and atomically publish broker/issuer/client/bridge/slot configuration for the new generation. Current broker/issuer manifests are fingerprint-pinned; live catalog update requires an explicit independently authenticated lifecycle protocol or coordinated restart with preserved registry migration. Replacing files around that invariant is not a valid implementation. Publisher must reject missing PID-namespace birth/stop evidence and never infer death from host PID absence. Normal configured static execution is complete; automatic multi-run lifecycle remains required before claiming W12 root-cause completion.
