# Independent workspace lease authority candidate

This is a local implementation candidate for task 15. No production service, host root, daemon configuration, deployment, user account, image or firewall has been changed by this work. Static fixed-slot preparation from task 12 is retained. The authority enables automatic successive execution leases within the operator-enrolled finite pool.

## Trust boundary and processes

The API contains no signing key and cannot register host paths, images, mounts, UIDs, profiles or permissions. Its root-owned client catalog holds only existing workspace selectors and opaque tickets. The broker independently retains immutable profile policy, registered roots and resource identities. An operator starts three separate authority processes:

1. `authority.mjs` is a root-owned Node24 process with a private Ed25519 key and private SQLite database. Its Unix socket is root-only mode 0600. It owns the writer fence, lease generation, one-use slot consumption and permanent legacy-label/broker-lease mapping.
2. `peer-front.py` is a root-owned Python process exposing one Unix socket to a dedicated API client group. It observes Linux `SO_PEERCRED`, effective UID/GID, PID start time, boot ID and the peer's target PID namespace. It supplies that observation to the root-only Node socket. Caller-supplied PID, observation, proof or policy fields are rejected. The API retains a private PID namespace and drops all capabilities.
3. `read-peer-namespace.py` is the fixed cross-UID read-only child of the root front and preview signer. It receives only the parent-observed integer PID/effective UID/effective GID. Python isolated/no-site mode, a clean environment, root working directory, a one-second timeout and a 128-byte response limit are fixed by callers. The child sets no-new-privileges, clears supplementary and ambient privileges, adopts the observed UID/GID, clears effective/permitted/inheritable capabilities, verifies they are zero, then reads only `/proc/<pid>/ns/pid`. The parent repeats its complete birth observation. An inaccessible, non-dumpable or replaced peer is denied. The root front needs SETUID/SETGID for this operation; it does not need SYS_PTRACE. The helper is never mounted into the API.

The root front and signer must observe the same host PID/proc view. Both verify `/proc/self/stat` agrees with their process PID. The target namespace remains part of the persisted birth identity; it is not replaced with the observer namespace. Native legacy guards may store a different local PID view. Those API-written fields are coordination selectors and never independent death evidence. Orphan cleanup requires an exact root-owned stop witness for the authority's independently observed birth.

The root front socket, parent directories, helper source, private manifest, key, witness directories and registry must be protected against API writes and symlinks. The Node CLI requires its key-bearing manifest to be root-owned and mode 0600. Lifetime SQLite exclusive locks prohibit two authority processes opening the same registry. The manifest fingerprint is pinned across restart; changing it is not a live enrollment protocol.

## Fixed manifest

The Node authority manifest has these fields:

```json
{
  "version": 1,
  "audience": "workspace-broker",
  "keyId": "operator-key-id",
  "privateKey": "<root-only Ed25519 PKCS8 PEM>",
  "apiUid": 10001,
  "registryDirectory": "/var/lib/chisa-workspace-authority",
  "preparedDirectory": "/var/lib/chisa-provider-prepared",
  "stopWitnessDirectory": "/var/lib/chisa-workspace-stopped",
  "brokerSocketPath": "/run/chisa-broker/broker.sock",
  "privateSocketPath": "/run/chisa-workspace-authority/private.sock",
  "entries": [
    {
      "id": "fixed-session-enrollment",
      "ticketHash": "<SHA256 of the opaque API ticket>",
      "ownerId": "owner-one",
      "userId": "17",
      "root": "/operator/enrolled/workspace",
      "rootDev": "<full decimal device>",
      "rootIno": "<full decimal inode>",
      "nativeAccountGroupId": 10105,
      "rootUid": 10002,
      "workspaceId": "fixed-workspace",
      "generation": "fixed-generation",
      "bindingEpoch": "fixed-epoch",
      "sessionId": "fixed-app-session",
      "expiresAt": 1900000000000,
      "permissions": ["run", "exec", "stdin", "stream", "status", "cancel", "reconcile", "logs", "preview"],
      "slots": [
        {"slotId": "slot-one", "profileId": "provider-one", "provider": "opencode", "profiles": ["provider-one", "fixed-shell"], "preparedProfiles": ["provider-one"]},
        {"slotId": "slot-two", "profileId": "provider-two", "provider": "opencode", "profiles": ["provider-two", "fixed-shell"], "preparedProfiles": ["provider-two"]}
      ]
    }
  ]
}
```

For native metadata commits, `nativeAccountGroupId` and `rootUid` are an optional operator-only pair. When present, the authority requires a non-root API UID, a direct workspace parent owned by root with exact mode `01770` and the enrolled metadata group, and a leaf with the exact enrolled UID distinct from the API UID plus its original device/inode. Ancestors above that direct parent retain protected root ownership. The provider supervisor uses the identical pair on each slot plus top-level `apiUid`, and the broker workspace manifest uses the same pair. Every worker profile UID/GID must differ from the metadata group, and Docker has explicit empty supplementary groups with all capabilities dropped. API requests cannot set these fields. The dedicated API group can commit its own guard/generation/lease entries while sticky directory rules prevent it renaming the worker-owned workspace. Workers do not receive the metadata group. A missing pair retains the original strict root-ancestor policy; it never implicitly permits an API-owned account directory. Operator changes to parent mode/group or leaf UID/device/inode fail closed on later grants and preparations.

Every slot source, mount, binary, credential and HOME already exists in the provider supervisor and broker manifests. `profileId` is the default provider profile. `profiles` is an operator-only list of additional semantic operation profiles for the same lease; an API request may select one existing entry, never submit an array or policy. `preparedProfiles` is a subset whose run/exec grants require the independently sealed provider witness. A provider grant's expiry cannot exceed that witness's expiry. Runtime profile requests never change immutable broker mount/environment/UID policy.

A maintenance entry uses `maintenance: true`, one exact `profileId`, no slots and only `network`, `retire`, `status` permissions. It can restore the existing account network and retire an exactly enrolled old transport, but cannot execute a process or consume a provider slot. It has its own opaque ticket and fixed identity.

The root front manifest is separate and contains no API-selected path:

```json
{"version":1,"apiUid":10001,"clientGroupId":10010,"socketPath":"/run/chisa-authority/issuer.sock","privateSocketPath":"/run/chisa-workspace-authority/private.sock","previewSocketPath":"/run/chisa-preview-authority/private.sock"}
```

The API's existing broker client catalog adds `authoritySocketPath` instead of an issuer socket. Each entry still has the exact root/workspace/generation/default-profile and opaque ticket. A workspace used for cloud preview additionally has an operator-static `previewProfileId`; that profile must already appear in the slot's `profiles` and in immutable broker policy. Preview startup requires the bridge's server-created readonly `broker:{leaseId,legacyReservationId,sessionId,profileId}` reservation to match that exact catalog profile and independently looked-up lease/session. Missing preview enrollment fails closed; it never selects the provider profile or provider credentials as a fallback. `CHISA_PROVIDER_SLOT_CLIENT_CONFIG` lists the entire pre-enrolled fixed pool; dynamic templates use an empty `leaseId`. Selection uses only the authority-returned slot ID, then checks owner/user/session/root/workspace/generation/epoch/profile before sending bytes. The supervisor uses its root-private `/v1/slot-binding` channel to obtain the independently active lease. It seals each slot permanently; an API cannot replace sealed bytes after cleanup.

## Public protocol

Public messages contain ticket and existing selectors. No registration endpoint exists. All requests are bounded, have fixed JSON fields and run over protected Unix sockets.

- `POST /v1/begin`: `{ticket,userId,root,workspaceId,generation,bindingEpoch?,sessionId?,legacyReservationId?}`. The authority independently selects a static enrollment and generates a random broker lease. The legacy label is recorded only as a mapping. Repeating the same label and exact observed peer returns the same mapping; a different writer or label cannot bypass an active/stopping fence. An omitted label joins exactly one already-active mapping for that peer; it does not invent an execution reservation.
- `POST /v1/lookup`: same exact scope with a known `leaseId` and legacy label. It reads the retained mapping and never begins a new lease, including after close.
- `POST /v1/grant`: mapping selectors plus one fixed `profileId` and `permission`. The authority signs short Ed25519 broker grants from private state. Run/exec/stdin are denied unless the lease is active. Status and cleanup controls remain available for retained closed/stopping mappings. Prepared run/exec profiles reopen their root-owned witness for each grant.
- `POST /v1/end`: exact mapping selectors. The original admitted peer may request a broker close. The authority persists `stopping`, asks the broker to permanently quiesce that lease, checks exact scope, immutable resource inventory, timestamps, broker instance and confirmed absence, then persists `closed`. An error leaves `stopping`; a retry cannot consume another slot. Broker closure alone does not release a native writer guard.
- `POST /v1/release`: the original native guard helper supplies the exact legacy label, optional known broker ID, scope and `purpose`. The front observes the helper and its real parent. `live-writer-release` requires that parent to be the exact independently admitted writer birth. `legacy-writer-release` requires a root-owned stop witness. Only then does the authority perform/reuse broker close and return the complete receipt. The legacy guard still performs its own exact native CAS release while its original locks remain held.

Mapping responses include `ownerId,userId,root,workspaceId,generation,bindingEpoch,sessionId,legacyReservationId,leaseId,slotId,profileId,state`. Closed receipts add `quiescent:true,cleanupConfirmed:true,resourceInventoryComplete:true,closedAt,confirmedAt,brokerInstanceId,resources:[{operationId,resourceId}]`. The complete-inventory flag is produced only by the independent broker after its permanent dispatch fence, full recorded-resource cleanup, exact ID/name absence checks and independent workspace inventory query all succeed. An empty complete inventory can prove that a reserved preview never dispatched. Missing or false flags cannot close/reuse a lease, including legacy persisted closed receipts; they require reviewed recovery and never silently migrate. Requested operation absence is accepted only under this complete independently fenced inventory, with the separate exact native stop witnesses still mandatory. Resources must be immutable 64-hex IDs; unknown creates, foreign/replaced containers, unresolved orphans or daemon uncertainty cannot authorize the next lease. The broker permanently rejects old run/exec proofs even if independently re-signed later.

For native recovery, the existing fixed `/etc/chisa/workspace-broker-recovery.json` has `authoritySocketPath`, `authorityUid:0` and operator-only workspace entries `{root,userId,ownerId,workspaceId,generation,bindingEpoch,sessionId,ticket}`. It does not need per-run lease rewrites. The Python guard chooses that static entry, then sends its current legacy label and any known broker ID/session only as selectors. It must not read a caller-selected endpoint or accept a caller-provided death verdict.

An orphan stop witness is `/var/lib/chisa-workspace-stopped/<brokerLeaseId>.json`, protected and root-owned:

```json
{"version":1,"stopped":true,"leaseId":"<broker ID>","legacyReservationId":"<legacy label>","root":"/operator/enrolled/workspace","bindingEpoch":"fixed-epoch","writer":{"pid":123,"uid":10001,"gid":10001,"processStartTime":"456","bootId":"<boot UUID>","pidNamespace":"pid:[4026531836]"},"stopId":"<independent stop receipt>"}
```

That record belongs to the independent supervisor. API metadata, a missing PID, an API boolean and a broker cleanup result do not establish the native writer's death.

## Preview authority handoff

The runtime preserves `/api/workspace-runtime/preview/<64hex>/` as its browser capability and sandbox/CSP base. It no longer opens arbitrary broker private IPs. The root front forwards `/v1/preview-ticket` and `/v1/preview-close` to the independent preview signer with the genuine observed peer. Both requests use exactly:

`{ticket,userId,root,workspaceId,generation,sessionId,bindingEpoch,legacyReservationId,leaseId,operationId,base}`.

The signer calls the root-only producer `/v1/preview-authorization` with `{request,observation:{peer}}`. The authority validates the current active mapping and peer, independently queries broker status, and durably pins the operation/base pair. It returns `{version:1,...exactMapping,ownerId,profileId,expiresAt,statusProof,previewProof}` with at most 60 seconds of validity. The signer independently verifies current immutable broker resource/IP/port and chooses its operator-fixed per-owner gateway endpoint. Only the opaque returned ticket enters the runtime request header `X-Chisa-Preview-Ticket`.

Gateway renewal is an independent server-to-server handle. Runtime does not hard-cut retained flows at the initial ticket expiry. Each new browser request gets a fresh ticket. The signer rechecks the initial peer and active authority mapping before renewal. Closing a preview creates/reuses an independent signer tombstone, including when a first ticket was never issued or its response was lost.

The admitting HTTP/provider layer captures a persistent-login closure on `WorkspaceRuntimePreviewReservation.assertAuthActive`. Runtime requires it for cloud preview startup, rechecks it before/after ticket issuance and while retaining streams, and sweeps retained capabilities every second. Logout, version revocation, expiry or authentication-store failure synchronously revoke local capabilities and close retained connections. Runtime retries the exact private signer close until acknowledged. A new login cannot revive the old capability. This revokes access; it does not itself release the native writer or kill an unrelated task. Current cloud/platform launches without a persistent-login proof cannot create previews. A new preview requires a new start operation after the prior one is explicitly stopped.

## Validation and remaining gates

Local tests use the real authority SQLite state, Ed25519 signatures, semantic broker/server/client, provider preparation service and default provider runner. A deterministic fake daemon supplies resource lifecycle responses; it does not grant authority. The same provider entry automatically executes twice with distinct broker leases and slots. Between rounds it exercises stopping/pending cleanup, authority restart, rejection of new leases and old signed run proofs, then exact cleanup before the next slot. Slot exhaustion fails explicitly.

```sh
node --test ops/workspace-broker/authority/authority.test.mjs ops/provider-slots/slot-supervisor.test.mjs
python3 -B ops/workspace-broker/authority/peer-front.test.py
cd cloudcli-ui
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --experimental-test-module-mocks --test server/modules/providers/tests/provider-slot.test.ts "server/modules/workspace-runtime/tests/*.test.ts"
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

Linux peer identity, cross-UID fixed helper, capability-restricted service behavior, real preview producer/signer/gateway long HTTP/SSE/WS and the exact source snapshot are independently staged by the Lead and task 17 owner. The Windows combination fixture explicitly injects its root-front observation only within the test boundary. It is not Linux SO_PEERCRED evidence. Real Docker Engine behavior, native Linux provider artifact contents, deployment/service installation, operator pool sizing/refill, per-owner API isolation and G1 off-host recovery remain acceptance gates. Exhaustion cannot reset tombstones or silently reconfigure the live manifest; a reviewed pool extension/migration protocol is separate from normal automatic operation.
