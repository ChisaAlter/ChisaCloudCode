# Windows SSH workspace transport

This module keeps the coding agent and its authentication on the VPS. It sends bounded project operations to the on-demand [Windows helper](../../../../../app/resources/ssh-workspace.ps1) through an authenticated desktop HTTPS relay, a loopback Agent endpoint, or a protected system OpenSSH catalog. The relay uses the existing authenticated API and needs no desktop SSH service. Relay v2 may reoffer the same unacknowledged transport request; a durable native receipt prevents repeating local execution. This module never falls back to the server filesystem.

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

Agent registration accepts `delivery: 'relay'` for authenticated HTTPS polling, or defaults to `direct` for existing loopback tunnels. Registry IDs are scoped by `(owner_id, id)`; migration preserves tokens and timestamps. Public responses omit credentials. Every relay message requires both the signed-in account and the exact current Agent token. Token rotation invalidates old delivery rights. The safe catalog includes relay protocol, last activity and queued/offered/received counts without epochs, request IDs or payloads.

### Relay v2 delivery contract

Legacy polling without `protocol=2` retains its original at-most-once behavior. Native clients opt into v2 with `GET /api/ssh-workspaces/agent/relay/poll?connectionId=…&wait=0&protocol=2`. A new server answers `{ready:true,protocol:2,epoch,jobs:[]}`. An old server omits the version/epoch, so a new native client must use its legacy path. A v2 channel cannot downgrade within the same token session.

A v2 handshake or poll response may include `capabilities:{events:1}`; agents that advertise-compatible report workspace filesystem observations through `POST /agent/relay/events` with `{connectionId,epoch,events:[{root,rootIdentity?,path,kind}]}`. Events are advisory only: they invalidate the server-side read cache and notify subscribed sockets (`ssh_workspace_changed` frames); they never authorize or trigger any write. Batches are epoch-fenced, bounded, and deduplicated per root.

- Receive: normal `poll?connectionId=…&protocol=2` returns at most four `{requestId,payload,deadlineAt}` jobs. `deadlineAt` is the caller's absolute UNIX millisecond deadline, not a renewed budget. Unacknowledged offers have a three-second receipt lease; a lost receive response is reoffered with the identical ID, immutable payload and deadline. The lease wakes an outstanding long poll. Controls lead each batch, with regular FIFO progress reserved during control saturation.
- Receipt ACK: persist the native receipt first, then `POST /agent/relay/ack` with `{connectionId,epoch,requestId}`. Execute only on `{ok:true,accepted:true,epoch}`. Duplicate ACKs are accepted while the same request remains pending. Cancelled, expired, never-offered and stale-epoch IDs return `accepted:false`; they cannot start local work. A lost ACK response may be retried. ACK stops offer redelivery, so the native receipt and its completed result must remain durable across reconnects.
- Admission refusal: if the native journal cannot safely claim the offered request, post `{connectionId,epoch,requestId}` to `/agent/relay/reject`. Only an offered, unacknowledged v2 request can be rejected; the broker returns a typed `AGENT_BUSY` 503 reply to its caller immediately and removes execution permission. Duplicate, stale-epoch and already-ACKed rejections return `accepted:false`. Storage or capacity pressure must never launch unjournaled work or strand it until the request timeout.
- Heartbeat: the native process independently posts `{connectionId,epoch,activeRequestIds}` to `/agent/relay/heartbeat`, normally every five seconds, even while receives or helpers wait. The response is `{ok:true,epoch,obsoleteRequestIds}`. Stop local work whose ID is obsolete. An epoch change makes every supplied old active ID obsolete; re-handshake and retain native receipts for recovery. The broker bounds a heartbeat to 128 IDs. Authenticated poll, ACK, result and heartbeat messages refresh liveness; the existing 40-second offline window is unchanged.
- Result: durably cache the response and post `{connectionId,epoch,requestId,response:{status,body}}` to `/agent/relay/result` until an `{ok:true,accepted,epoch}` response. `accepted:false` is a terminal transport correlation, including duplicate/expired/old-epoch results; the native journal still retains its record for the recovery retention window. Identical retries do not rerun work; conflicting duplicate v2 responses are rejected while the bounded response hash is retained. Results without a receipt ACK cannot settle v2 requests.
- Caller cancellation/deadline: `agentRelayBroker.call` receives `{deadlineAt}` as its final option. Cancellation or deadline releases pending bytes and correlation immediately; heartbeat reports any corresponding local execution obsolete. Before v2 receipt ACK, removing the pending request also prevents a later ACK from authorizing execution. After receipt ACK, the caller retains dispatched/uncertain semantics until a native operation/job receipt confirms teardown. Timeout constants are unchanged.

The broker is bounded process-local delivery state, not a durable operation journal. A server restart changes the channel epoch and cannot resume the original HTTP promise. Native durable request receipts prevent replay; SQLite writer job/operation IDs and native helper receipts reconcile any side effects before releasing a writer. Native results and file/command receipts are separate layers: transport ACK is never proof of successful mutation or cleanup. Native execution slots and result delivery slots must also remain separate so slow result acknowledgements cannot block receives or recovery controls.

Inspection results (`stat`, `lstat`, `list`, `realpath`, `read`, `search`, `grep`, `batch`) are cached briefly per `(owner, connection, rootIdentity)` bucket — only for identity-pinned targets — so repeated reads skip the relay round trip. Filesystem events from the desktop watcher, any mutation and every `exec` invalidate the affected bucket; TTL bounds staleness when no watcher is active. The watcher runs lazily per served root with default generated-tree ignores plus optional project rules from `.chisa/workspace.json` (`includePaths`, `excludePaths`).

Direct HTTP is pinned to `127.0.0.1` and a validated port, never follows redirects, and reads at most 16 MiB before buffering a result. Agent tokens are exactly 64 lowercase hex characters. Typed pre-dispatch refusals (authentication, invalid request/root, request size, busy admission) preserve their status without claiming an online helper. A helper refusal confirms transport only with authenticated protocol/platform and the pinned physical root.

File operations are `stat`, `lstat`, `list`, `batch`, `realpath`, `read`, `write`, `mkdir`, `rename`, `copy`, `remove`, `search`, `grep`. `batch` accepts inspection operations only. Paths are project-relative or under virtual `/workspace`; they are not literal Windows shell paths. Destination operations use `destination`. Directory deletion requires `recursive: true` for recursion. Existing writes require `expectedHash`; creation requires `null` and uses exclusive file creation. The helper holds a nonshared existing-file handle across hash comparison and write.

Command operations are `exec`, `job_status`, `job_cancel`, `job_output`. `exec` accepts either a PowerShell `command` string or `argv` (not both), `path`, and a 1–600 second timeout. `job_output` takes `jobId`, `stream` (`stdout`/`stderr`, default `stdout`), a byte `offset` and `maxBytes` (1–256 KiB) and returns `{offset,total,chunk(b64),eof,state,truncated}`; it rides the relay control lane so output polling stays responsive under regular-work saturation. Helpers older than 1.0.3 refuse the op with `SSH_WORKSPACE_REQUEST_INVALID`; callers should treat that as "output available only at completion". Exact argv elements `/workspace` and `/workspace/...` map to the Windows root. Shell command text is not rewritten; use relative paths there. Arbitrary commands cannot be forced read-only, so `exec` rejects `readOnly: true`; the caller must omit exec entirely from plan/inspection sessions.

`exec` results contain actual `stdout`, `stderr`, `exitCode`, `jobId`, `cleanupConfirmed`, `timedOut`, `cancelled`, and truncation status. Output drains continuously and retains at most 1 MiB per stream. Helper 1.0.3 additionally spills each stream into the durable job directory (8 MiB cap per stream, `.truncated` marker beyond it) so `job_output` can serve incremental reads while the command still runs. Descendants are attached to a kill-on-close Windows Job Object before execution resumes. A disconnect/abort attempts independent remote cancellation; a missing job receipt alone is not proof that no command ran. When cancellation atomically wins the same permanent job-ID claim used by execution, it can confirm cancellation before startup and reject a delayed original request. An existing claim without state remains unconfirmed. `SSH_EXECUTION_UNCONFIRMED` carries `{jobId, cleanupConfirmed:false}` in `details`; retain the writer recovery barrier and explicitly query/cancel that job. Never retry a mutation automatically.

An Agent file mutation receives a unique top-level `operationId`; the native Agent claims a durable receipt before helper dispatch. Unknown completion returns `SSH_OPERATION_UNCONFIRMED`, retaining the durable writer recovery fence. HTTP abort is not proof that a file operation stopped. Recovery uses only `operation_status` or `operation_cancel` with the persisted ID, exact Windows root/identity and generation. `not_found`, `running`, and `unknown` never release the fence. A matching completed/cancelled receipt with `cleanupConfirmed: true` allows explicit recovery; an atomic pre-dispatch cancel tombstone prevents a delayed original request from starting. The original mutation is never resent. Legacy file uncertainty without a receipt remains fenced and reports `SSH_OPERATION_RECOVERY_UNCONFIRMED` rather than pretending a probe proved cleanup.

## Helper deployment and limits

Install the helper outside the writable project, readable by the dedicated Windows SSH account and not writable by generated project code. The desktop can install an embedded versioned copy; provision its final path in the server catalog. Protocol 1, helper version `1.0.3`, single UTF-8 JSON envelope on stdin, one JSON result on stdout. No script arguments or background service are required.

The helper rejects path traversal, other drives, UNC/device paths, alternate streams, reserved names, reparse/junction ancestors and hard-linked files. It pins directory handles against replacement and validates the physical root identity. These file-tool checks do **not** sandbox arbitrary command code: use a dedicated Windows account and suitable NTFS permissions. Job Objects supervise normal task lifecycle/resources, not malicious persistence or all possible process-launch mechanisms. The caller owns per-target serialization and duplicate physical-project detection; the helper does not establish a global write lease.

Job state lives in the Windows execution user's LocalApplicationData outside the project. Records intentionally survive interruptions for explicit recovery; this module performs no broad cleanup of historical job state or unrelated processes. Interactive PTY/desktop automation is not provided (`terminal: false`); the application may build a command-pipe console using exec.

## Verification

Run focused tests from the cloudcli-ui root:

```text
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --test server/modules/ssh-workspaces/tests/ssh-workspace.test.ts server/modules/ssh-workspaces/tests/helper-local.test.ts server/modules/ssh-workspaces/tests/helper-lifecycle.test.ts
node node_modules/oxlint/bin/oxlint server/modules/ssh-workspaces
```

The transport tests use injected process mocks and no network. Windows helper tests use temporary local directories and controlled child processes, and skip on other platforms. They do not configure SSH, install services or establish remote connections. Real Windows/VPS network and deployment verification remains a separate integration check.

The standalone [native compatibility harness](tests/agent-relay-native-harness.ts) runs the real broker with synthetic in-memory registration on an ephemeral loopback port. Set `CHISA_RELAY_QA_DIR` to an absolute isolated directory, then start it with `node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json server/modules/ssh-workspaces/tests/agent-relay-native-harness.ts`. A compiled copy runs directly with Node on either platform. It writes `ready.json` (origin/port) and `reports.json` (safe event trace) into that directory. It is a test CLI and is never mounted by application startup.

The harness exposes `/qa/enqueue` (connectionId, payload, timeoutMs, label), `/qa/state`, `/qa/abort` (label), `/qa/reset` (connectionId), and `/qa/shutdown`. `/qa/faults` accepts counters `{poll,ack,result}` and destroys exactly that many real HTTP responses after the broker has offered/accepted work, reproducing the original loss windows. Optional `CHISA_RELAY_QA_STDIN=1` also accepts JSONL enqueue/status/shutdown actions. The [socket regression test](tests/agent-relay-native-harness.test.ts) exercises all three lost-response windows, epoch reset and admission refusal against that actual broker; `CHISA_RELAY_QA_HARNESS` can point it at an isolated compiled harness. Native Go integration can use the same endpoints to verify journal/execution behavior against the production broker state machine.
