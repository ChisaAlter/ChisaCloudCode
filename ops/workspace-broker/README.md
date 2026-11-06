# Workspace broker candidate

This directory is local candidate tooling. Nothing is installed, deployed or connected to production. G1, Linux Docker integration and W12 owner/UID/HOME/network migration remain gates.

Build the server through the repository's normal candidate build. Run the independent process with explicit canonical paths:

```sh
node /opt/chisa-broker/broker-launcher.mjs /etc/chisa-broker/manifest.json /opt/chisa-broker/dist-server/server/modules/workspace-broker/index.js
```

The private operator manifest has four fields: `configuration` matching WorkspaceBrokerConfiguration, `dockerSocketPath`, `brokerSocketPath`, and optional numeric `clientGroupId`. It contains public issuer keys only; issuer private keys belong to an independent trusted authority. Place the registry outside all workspace/API-readable roots. The launcher verifies a broker-owned 0600 manifest, Linux Unix daemon socket and canonical module path. Deploy the launcher and compiled module root-owned, immutable to API and workers; neither API nor worker receives a docker group/socket/binary bypass. The source process has no automatic server entrypoint side effects and no fallback.

Use an operator-owned 0700 registry directory and 0750 socket directory. A dedicated client group may traverse the socket directory and use the 0660 broker socket; it must not write the directory. `clientGroupId` makes the socket group explicit. The registry and authority manifest remain inaccessible to this group. Broker process access to Docker is a privileged administration capability, even under a non-root uid. Linux service UID/GID and exact controlled roots must be chosen in W12 before deployment.

A stale broker socket is deliberately not auto-unlinked: after a crash, stop the supervisor, prove the broker lifetime lock is unheld, verify the stale socket inode/owner, remove only that exact socket, and restart. No PID or connection failure alone proves there is no old broker. SQLite's lifetime exclusive lock independently prevents a second broker from dispatching against the same registry.

The minimal supervised launch requires:

- broker-only daemon socket permission and read-only code/config; private writable registry;
- all configured owner root ancestors outside worker-write permissions; no overlapping cross-owner roots;
- per-owner bridge network, default Docker seccomp, cap-drop ALL, non-root worker uid, no host namespaces/devices/ports;
- memory/CPU/PID/tmpfs/output/stdin/time budgets from fixed profiles; Docker log rotation;
- private Unix endpoint, aggregate request/connection limits and signed owner/workspace/generation/lease authorization on every request;
- service logs that exclude proofs, command payloads, environment values, host inspect data and model secrets;
- audited operator migration of old writer witnesses, leases, permanent guards and orphan resource inventory before API admission.

`shared-contract.proposal.txt` was the exact request to Lead; the authoritative four declarations now live in the shared backend module. It is not a second runtime schema. See the frozen protocol and call-site inventory under `docs/remediation/2026-10-31/W11`.

Local checks from `cloudcli-ui`:

```sh
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --test server/modules/workspace-broker/tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
node node_modules/oxlint/bin/oxlint server/modules/workspace-broker
```

Windows executes the full semantic/SQLite/realpath/transport suite using an isolated named pipe; Linux-only Docker adapter mock-daemon and open-file inode replacement cases are explicitly skipped there. Named pipes are test compatibility, not a Windows Docker adapter or production peer-authentication policy.
