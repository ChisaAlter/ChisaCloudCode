# Native local workspace Agent

Cloud authentication, projects and API/WebSocket forwarding keep their existing behavior. Local workspace execution is explicitly activated after login; cloud-only use does not start an Agent. Provider authentication and Claude execution stay on the server. The desktop runs the bundled Windows workspace helper as the current Windows user.

## Default authenticated HTTPS relay

`EnsureSshAgent("")` selects an existing current-account Agent profile or creates an account-bound profile with `mode:"agent", agentTransport:"relay"`. A new relay profile requires no OpenSSH client/server, keys, service installation, administrator rights, manual host/port configuration or inbound firewall change. It uses the current verified account service connection. Existing saved profiles retain their explicit transport; an absent `agentTransport` preserves the former reverse-SSH behavior.

The native supervisor starts its loopback Agent on an ephemeral port, generates a private 256-bit token, and sends `POST /api/ssh-workspaces/agent/connections` with `{id,name,port,token,delivery:"relay"}` over the captured authenticated account connection. It then requires an authenticated `GET /api/ssh-workspaces/agent/relay/poll?connectionId=<id>&wait=0` handshake with `{ready:true,jobs:[]}` before reporting readiness. Neither registration nor a running listener alone is success. An old server without this relay contract returns an actionable registration/handshake error.

Subsequent polls wait up to 25 seconds and deliver at most four `{requestId,payload}` jobs. Native forwards each job once to its loopback Agent, with the private token. It accepts subsequent jobs concurrently so command cancellation and recovery remain available during running commands. Results are posted as `{connectionId,requestId,response:{status,body}}`, where body is the raw JSON string. Lost result delivery retries only the identical cached result; it never resends the workspace operation. Repeated request IDs cannot execute again in the same supervisor session. Poll, result and registration requests use the current native account token, not a JavaScript-supplied token.

Transient polling failures use bounded exponential backoff (1 to 32 seconds) with the same Agent/token. Authentication/protocol failures terminate the session. Stop, logout, account/service replacement and desktop close cancel polling, result delivery, registration and active helper requests. A terminal native status is published only after registration/relay workers, Agent listener and admitted helper processes have finished cleanup.

## Native API

Calls go through `FrontendBridge`. They require the current native authenticated account and return fixed safe errors `{ok:false,code,error}`. No public status, result or application log contains Agent tokens, account tokens, key contents or raw SSH diagnostics.

| Method | Arguments | Result |
| --- | --- | --- |
| `EnsureSshAgent` | profile ID string; empty selects/creates account default | `{ok,profile?,status?,code?,error?}`; waits at most 35 seconds for authenticated delivery plus registration, never returns success for starting/reconnecting alone |
| `GetSshTunnelProfiles` | none | `{ok:true,profiles,statuses}` for current account only; listing does not create or start anything |
| `SaveSshTunnelProfile` | profile input | `{ok:true,profile}`; relay requires name, mode agent and agentTransport relay |
| `StartSshTunnel` | profile ID | `{ok:true,status}` promptly; Agent modes join the same supervisor and native registration |
| `StopSshTunnel` | profile ID | `{ok:true,status}`; idempotent, stopping until cleanup completes |
| `GetSshTunnelStatus` | profile ID | `{ok:true,status}` |
| `SelectSshLocalFolder` | none | `{ok:true,path}` or `{ok:true,cancelled:true}` |
| `SelectSshIdentityFile` / `SelectSshKnownHostsFile` | none | selected absolute reference only |
| `GetSshPreflight` | none | read-only Windows OpenSSH inspection, for explicit SSH compatibility modes |
| `GetSshDefaults` | none | legacy references only when prior enrolled account/service and pinned host match; otherwise configuration-required error |

Concurrent ensures join one profile generation, listener and registration. Registration failure stays separate from forwarding and is retried idempotently by another Ensure. An ensure timeout does not pretend readiness or cancel another caller's shared supervisor. Explicit Stop and account/window lifetime own cancellation. An Ensure after Stop waits for the prior listener/helpers to finish before restarting.

```ts
interface SshTunnelStatus {
  profileId: string;
  state: 'stopped' | 'starting' | 'forwarding' | 'reconnecting' | 'stopping' | 'error';
  generation: number;
  outerConnected: boolean;
  verified: false;
  registrationState?: 'unregistered' | 'registering' | 'registered' | 'error';
  registrationError?: string;
  reconnectAttempt?: number;
  code?: string;
  message?: string;
}
```

`outerConnected` acknowledges the relay handshake or actual OpenSSH reverse-listener acknowledgement. `verified` remains false: the server independently probes the selected physical project directory and required tools. Registration state and forwarding/delivery state are independent.

Profiles persist only nonsecret references and account ownership in a versioned `ssh-tunnels.json`; runtime state and tokens are never persisted. Profiles restore stopped and are ensured on explicit local use by the frontend. Malformed profile stores are preserved and fail only the optional local feature. A saved profile includes `id`, `accountBinding` and `serviceUrl`, derived natively from service, instance and account identity. Another account cannot read/adopt/start it. Global legacy keys are never automatically adopted into a new account's relay default.

## Helper lifetime and mutation recovery

The embedded PowerShell helper is installed outside writable project directories under a hash-versioned path. Installation verifies exact existing bytes and refuses changed content. This does not isolate the helper from another process running as the same Windows account.

Workspace requests use request and Agent lifetime contexts with a 650-second upper bound. Helpers are assigned to a kill-on-close Windows Job Object before their stdin payload is released; owner creation/assignment failure dispatches no operation. Cancellation terminates the owned process tree, waits for the helper and confirms the Job Object has no active processes. Agent.Close waits for admitted handlers, receipt persistence and helper cleanup before terminal state permits a new listener. Cancellation does not undo a file mutation already performed.

The HTTP listener is loopback-only, requires the private token before parsing workspace operations, limits bodies to 12 MiB and has header/body/idle timeouts. Four regular helper requests may run concurrently. An accepted regular request can wait up to 15 seconds before helper dispatch; the waiting queue admits at most eight requests and 24 MiB of retained request bodies. Cancellation or shutdown while waiting releases admission without claiming an operation ID or starting a helper, and a full/expired queue returns the safe predispatch `AGENT_BUSY` refusal. This waits on the same accepted request and never retries or replays it. Job status/cancel and operation receipt control have a separate lane. Helper stdout is bounded to 16 MiB and stderr to 64 KiB; overflow cancels the tree and returns a safe unavailable result. Serialized relay results are bounded to 24 MiB. Native relay admission permits eight regular workers and four reserved control workers; result delivery has a 30-second deadline and an estimated 24 MiB retained-result budget. Those are independent of the server's queue limits; the budget is not a claim about total peak memory during response parsing/encoding. Large or interrupted responses require recovery, never operation replay.

For `write/mkdir/rename/copy/remove`, the backend supplies a UUID `operationId`. Before dispatch, native durably claims that ID with exact root path, physical identity and generation. Duplicate IDs are refused without replay. Completed/reaped requests persist a receipt; `operation_status` returns its state and `cleanupConfirmed`. `operation_cancel` can atomically tombstone an undispatched ID or cancel and wait for its active owned helper. Missing status alone never proves cleanup. A crashed/incomplete persisted claim remains unknown rather than claiming success. Receipts live outside the hash-versioned helper directory so normal helper upgrades preserve them.

Command jobs retain their existing durable `jobId` status/cancel protocol. Invalid cwd/command/argv/timeout is checked before a permanent command claim. A v2 claim remains held until terminal state publication; cancellation can distinguish a crashed marked pre-state executor from a live one. Unmarked historical claims remain conservatively uncertain. Pinned helper refusals include the actual physical root identity; identity mismatch is not represented as a confirmed connection.

## Explicit reverse-SSH compatibility

`mode:"ssh"` retains system-sshd behavior. `mode:"agent", agentTransport:"ssh"` (or absent transport in old saved profiles) retains a bundled Agent behind reverse SSH. Those explicit modes still require a configured OpenSSH client, key reference and preverified known_hosts; system-sshd also needs its existing server prerequisites.

The native manager owns one foreground OpenSSH process, with config discovery disabled, strict host keys, explicit identity/loopback reverse port, BatchMode, ExitOnForwardFailure, keepalives and no proxy/local-command/sharing behavior. It never accepts or writes a host key. Agent reverse-SSH transient failures reconnect with the same Agent/token and never replay operations; host-key/authentication/launcher/configuration failures are terminal. System-SSH compatibility remains one-shot. Logout/close kills only app-owned processes, never unrelated ssh processes or services.

## Verification and limits

Run only the current root Go package; recursive `./...` includes historical snapshots.

```powershell
go test . -count=1 -timeout=600s
go vet .
```

Isolated tests exercise synthetic account HTTP servers, native relay registration/handshake/result retries, concurrent ensures, token redaction, account/logout/window cancellation, strict SSH failure/backoff, actual temporary Windows helper subprocess ownership/cancellation/output limits, durable mutation receipts and command-claim recovery. These tests do not constitute a real desktop/WebView/server end-to-end acceptance or a production deployment. Candidate UI/login/Claude flows and actual network interruption must be recorded separately by the release owner. No test uses user project directories or restarts a running production desktop.
