# Windows SSH workspace transport

This module keeps the coding agent and its authentication on the VPS. It sends bounded project operations to the on-demand [Windows helper](../../../../../app/resources/ssh-workspace.ps1) through an authenticated desktop HTTPS relay, a loopback Agent endpoint, or a protected system OpenSSH catalog. The relay uses the existing authenticated API and needs no desktop SSH service. This module never replays an operation and never falls back to the server filesystem.

## Connection catalog

Set `CHISA_SSH_CONNECTIONS_FILE` to an absolute, administrator-managed JSON file. On POSIX the file must not be writable by group/other users; it must be a regular non-symlink file no larger than 1 MiB. Keep it and credential files outside writable projects.

```json
{
  "connections": [
    {
      "id": "work-laptop",
      "name": "Windows laptop",
      "ownerId": "42",
      "host": "127.0.0.1",
      "port": 22022,
      "username": "cc-worker",
      "identityFile": "/srv/chisa/ssh/work-laptop-key",
      "knownHostsFile": "/srv/chisa/ssh/known_hosts",
      "hostKeyAlias": "device-work-laptop",
      "helperPath": "C:\\ProgramData\\ChisaCloudCode\\ssh-workspace.ps1"
    }
  ]
}
```

The top-level array form is also accepted. `ownerId` is mandatory. A `*` owner is accepted only when `CHISA_SSH_ALLOW_SHARED_CONNECTIONS=1` and `VITE_IS_PLATFORM` is not `true`. Connection listing returns only `id`, `name`, `host`, `port`, `username`, `platform`. API clients cannot supply private file references or override connection settings.

The host alias should identify the Windows device rather than a recyclable loopback tunnel port. Both the outer reverse tunnel and the inner SSH session must have independently verified host identities. The service containing this adapter must be able to reach the reverse listener; a Docker container's loopback is not the host's loopback.

## Public API

Import only [the module barrel](index.ts). It exposes:

- `listSshConnections(userId)` — authenticated owner's safe catalog entries.
- `probeSshWorkspace({connectionId, rootPath, userId, signal?})` — actual helper/platform probe; returns required canonical Windows root and physical volume/file identity, helper version, username, safe connection ID/name and capabilities.
- `executeSshWorkspace({connectionId, rootPath, userId, expectedRootIdentity?, generation?, request, signal?, onJobCreated?})` — explicit operation; non-null result or typed `SshWorkspaceError` (extends the shared application error).
- `createSshWorkspaceTransport(dependencies)` — deterministic process/catalog injection for focused tests.

Persist the successful probe's `rootIdentity` and supply it as `expectedRootIdentity` for every subsequent operation. `generation` is echoed transport context; the caller owns durable target/session generation checks. The optional `onJobCreated(reference)` callback runs before transmission and may throw to prevent execution. It receives a command job UUID or `operation:<uuid>` for an Agent file mutation; persist either reference under the exact writer lease.

Agent registration accepts `delivery: 'relay'` for authenticated HTTPS polling, or defaults to `direct` for existing loopback tunnels. Registry IDs are scoped by `(owner_id, id)`; migration preserves tokens and timestamps. Public responses omit credentials. Relay polling and result delivery require both the signed-in account and the exact current Agent token. Jobs are bounded, delivered once, and never requeued after an uncertain outcome. Native retries only delivery of a cached result. Token rotation invalidates old delivery rights.

Direct HTTP is pinned to `127.0.0.1` and a validated port, never follows redirects, and reads at most 16 MiB before buffering a result. Agent tokens are exactly 64 lowercase hex characters. Typed pre-dispatch refusals (authentication, invalid request/root, request size, busy admission) preserve their status without claiming an online helper. A helper refusal confirms transport only with authenticated protocol/platform and the pinned physical root.

File operations are `stat`, `lstat`, `list`, `batch`, `realpath`, `read`, `write`, `mkdir`, `rename`, `copy`, `remove`, `search`, `grep`. `batch` accepts inspection operations only. Paths are project-relative or under virtual `/workspace`; they are not literal Windows shell paths. Destination operations use `destination`. Directory deletion requires `recursive: true` for recursion. Existing writes require `expectedHash`; creation requires `null` and uses exclusive file creation. The helper holds a nonshared existing-file handle across hash comparison and write.

Command operations are `exec`, `job_status`, `job_cancel`. `exec` accepts either a PowerShell `command` string or `argv` (not both), `path`, and a 1–600 second timeout. Exact argv elements `/workspace` and `/workspace/...` map to the Windows root. Shell command text is not rewritten; use relative paths there. Arbitrary commands cannot be forced read-only, so `exec` rejects `readOnly: true`; the caller must omit exec entirely from plan/inspection sessions.

`exec` results contain actual `stdout`, `stderr`, `exitCode`, `jobId`, `cleanupConfirmed`, `timedOut`, `cancelled`, and truncation status. Output drains continuously and retains at most 1 MiB per stream. Descendants are attached to a kill-on-close Windows Job Object before execution resumes. A disconnect/abort attempts independent remote cancellation; a missing job receipt alone is not proof that no command ran. When cancellation atomically wins the same permanent job-ID claim used by execution, it can confirm cancellation before startup and reject a delayed original request. An existing claim without state remains unconfirmed. `SSH_EXECUTION_UNCONFIRMED` carries `{jobId, cleanupConfirmed:false}` in `details`; retain the writer recovery barrier and explicitly query/cancel that job. Never retry a mutation automatically.

An Agent file mutation receives a unique top-level `operationId`; the native Agent claims a durable receipt before helper dispatch. Unknown completion returns `SSH_OPERATION_UNCONFIRMED`, retaining the durable writer recovery fence. HTTP abort is not proof that a file operation stopped. Recovery uses only `operation_status` or `operation_cancel` with the persisted ID, exact Windows root/identity and generation. `not_found`, `running`, and `unknown` never release the fence. A matching completed/cancelled receipt with `cleanupConfirmed: true` allows explicit recovery; an atomic pre-dispatch cancel tombstone prevents a delayed original request from starting. The original mutation is never resent. Legacy file uncertainty without a receipt remains fenced and reports `SSH_OPERATION_RECOVERY_UNCONFIRMED` rather than pretending a probe proved cleanup.

## Helper deployment and limits

Install the helper outside the writable project, readable by the dedicated Windows SSH account and not writable by generated project code. The desktop can install an embedded versioned copy; provision its final path in the server catalog. Protocol 1, helper version `1.0.2`, single UTF-8 JSON envelope on stdin, one JSON result on stdout. No script arguments or background service are required.

The helper rejects path traversal, other drives, UNC/device paths, alternate streams, reserved names, reparse/junction ancestors and hard-linked files. It pins directory handles against replacement and validates the physical root identity. These file-tool checks do **not** sandbox arbitrary command code: use a dedicated Windows account and suitable NTFS permissions. Job Objects supervise normal task lifecycle/resources, not malicious persistence or all possible process-launch mechanisms. The caller owns per-target serialization and duplicate physical-project detection; the helper does not establish a global write lease.

Job state lives in the Windows execution user's LocalApplicationData outside the project. Records intentionally survive interruptions for explicit recovery; this module performs no broad cleanup of historical job state or unrelated processes. Interactive PTY/desktop automation is not provided (`terminal: false`); the application may build a command-pipe console using exec.

## Verification

Run focused tests from the cloudcli-ui root:

```text
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --test server/modules/ssh-workspaces/tests/ssh-workspace.test.ts server/modules/ssh-workspaces/tests/helper-local.test.ts server/modules/ssh-workspaces/tests/helper-lifecycle.test.ts
node node_modules/oxlint/bin/oxlint server/modules/ssh-workspaces
```

The transport tests use injected process mocks and no network. Windows helper tests use temporary local directories and controlled child processes, and skip on other platforms. They do not configure SSH, install services or establish remote connections. Real Windows/VPS network and deployment verification remains a separate integration check.
