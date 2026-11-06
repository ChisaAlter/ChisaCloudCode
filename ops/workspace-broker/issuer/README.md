# Independent grant issuer

Run this separate Linux service with Node24, never inside the API container:

```sh
node /opt/chisa-broker/issuer/issuer.mjs /etc/chisa-broker/issuer-manifest.json
```

The operator-owned 0600 manifest includes `version:1,audience,keyId,privateKey,registryDirectory,witnessDirectory,socketPath,clientGroupId?,entries`. The API must not read this manifest, private key, SQLite registry or writable witness directory. The socket directory may be 0750 and socket0660 for a dedicated API client group; the group cannot write the directory.

Each independently enrolled entry is `{ticketHash,ownerId,userId,root,rootDev,rootIno,workspaceId,generation,sessionId,leaseId,bindingEpoch,witnessId,profiles,permissions,expiresAt,recoveryPurpose?}`. `ticketHash` is SHA256 of a random 32-byte-or-longer hex ticket. The raw ticket is supplied to a specific authorized workload/client, never generated or registered by an API request. Root realpath/device/inode come from an operator or independent account/workspace provisioning transaction. The service persists this catalog to private SQLite and rejects silent enrollment/manifest changes on restart. There is no registration endpoint.

The independent supervisor publishes a bounded single-link witness at `<witnessDirectory>/<witnessId>.json` with `{version:1,root,workspaceId,generation,sessionId,leaseId,bindingEpoch,active:true,expiresAt}`. Before every grant/renewal the issuer validates the exact canonical root pin, ticket/catalog scope, expiry and trusted witness. A filesystem lease written by API alone is not that witness. A supervisor must independently authenticate the account/session and validate the actual writer lease before publishing it. Normal operator maintenance entries may use an explicit service session/lease to grant network/retire operations.

POST `/v1/grant` accepts `{ticket,userId,root,workspaceId,generation,leaseId?,bindingEpoch?,sessionId?,profileId,permission,recoveryPurpose?}`. The service returns `{proof,expiresAt,workspaceId,generation,leaseId,bindingEpoch,sessionId,profileId}`. The proof is an Ed25519 signature consumed by broker; owner is taken only from the private enrollment. Lifetime <=120seconds and further bounded by independent ticket/witness expiry. Runtime reacquires a grant before every control operation, so normal >5minute operations and later cancellation do not rely on a stale static proof. Existing streams retain their authorized bounded lifetime and deliver final receipts without reusing an expired proof.

Recovery entries that include `quiesce` must explicitly enroll `recoveryPurpose:'legacy-writer-release'|'live-writer-release'`; normal API tickets cannot acquire that permission. The request and trusted witness must repeat the exact purpose. Recovery witness includes `writer:{pid,processStartTime,bootId,pidNamespace}`. For legacy/orphan release it also contains `supervisorStopped:{pid,processStartTime,bootId,pidNamespace,leaseId,bindingEpoch,stopped:true,stopId}`, matching the writer and lease exactly. This receipt must originate from an independent trusted supervisor with visibility/fencing authority over the old writer. An API flag or current namespace missing /proc PID cannot create it.

The bridge recovery helper independently reads a fixed operator-owned recovery configuration, validates every protected parent/file, validates witness birth identity and connects directly to root-owned broker/issuer sockets using Linux SO_PEERCRED. It does not accept an API response as proof. Live release still requires the helper to prove the expected parent process birth and PID namespace; a live ticket is never orphan-death authority. The broker's permanent quiesce tombstone prevents future run/exec for that exact generation/lease even under renewed grants.

Compromised API boundary: it can exercise the union of unexpired tickets visible in its own read-only client catalog. A deployment putting all owners' long-lived tickets into one shared API preserves that union of authority; it is not a complete multi-tenant account boundary. Use separate per-owner workload identities or independently authenticated per-session ticket delivery before multi-tenant acceptance. A compromised issuer/supervisor can authorize owners within its key scope, and a compromised broker/daemon can control the host.

Local validation with no dependencies or Docker:

```sh
node --test ops/workspace-broker/issuer/issuer.test.mjs
```

Operator enrollment and trusted supervisor witness publication remain separate administrative actions. The service deliberately does not let the API self-provision them. An installation with a valid operator catalog/ticket/witness is fully usable; missing configuration fails closed and has no Docker fallback.
