# HTTP / WebSocket ingress policy (W09)

The entrypoint builds one immutable policy before database initialization and installs it before preview routes, parsers, public login/health endpoints, authenticated routes, and static files. The same instance protects WebSocket admission. This file documents source configuration; no production configuration was changed by the implementation.

## Exact configuration

- `CHISA_ALLOWED_HOSTS`: comma-separated exact HTTP Host authorities, such as `app.example,127.0.0.1:3001`. No schemes, wildcards, CIDRs, userinfo, trailing dots, alternate IPv4 spellings, or padded ports. Configure the public Host forwarded by the reverse proxy. With no setting, only `localhost`, `127.0.0.1`, and `[::1]` at `SERVER_PORT` (plus an explicitly bound literal IP) are allowed.
- `CHISA_ALLOWED_ORIGINS`: optional comma-separated exact canonical `http://` or `https://` origins with no trailing slash. Same-origin is allowed automatically. No `*`, `null`, regex, or suffix matching.
- `CHISA_TRUSTED_PROXIES`: optional comma-separated exact IPv4/IPv6 peer IPs. IPv4-mapped IPv6 is normalized. Express trusts only the immediate configured peer (hop zero); arbitrary forwarding chains never become trusted. `X-Forwarded-Proto` is accepted only from that peer and must be a single `http` or `https` value. `X-Forwarded-Host` never changes routing/redirect identity.
- `CHISA_ALLOW_NATIVE_HEADER_WS=1`: optional originless native WS compatibility, only with a Bearer header from an exact trusted proxy that is also a loopback peer. Normal desktop capability proxies send their captured service Origin and bound Authorization and do not need this exception.
- Platform bypass (`VITE_IS_PLATFORM=true` or `IS_PLATFORM=true`) refuses startup unless `CHISA_ALLOW_PLATFORM_LOOPBACK=1`, `HOST` is a literal loopback IP, all allowed hosts are loopback, and no proxy or additional origins are configured. It remains an isolated management mode. Platform does not grant tokenless WebSocket access.

HTTP includes `nosniff`, `no-referrer`, frame policy, permissions policy, and enforced `frame-ancestors/base-uri/object-src` directives. Resource CSP remains Report-Only for compatibility review; this is not a claim of a complete enforced resource CSP. HSTS is not enabled here. JSON is bounded at 4 MiB to preserve the existing 2 MiB avatar after base64/JSON encoding; urlencoded input is flat, 64 KiB, with at most 256 parameters. Preview bodies remain streams and multipart retains route-specific budgets. Headers are limited to 64 and header receipt to 15 seconds.

A CSP-sandboxed preview deliberately has an opaque Origin. Only canonical `/api/workspace-runtime/preview/{64 lowercase hex capability}/...` paths may pass `Origin: null` to the preview module's own capability verifier. Duplicate slashes, dot segments, encoded separators and double encoding fail. This exception does not grant authentication, does not accept ordinary API routes, and does not bypass the preview module's owner/generation/lease checks or credential stripping. Preview WS first applies the same Host and scoped Origin check.

## Authentication contract

`POST /api/auth/ws-ticket` is implemented in the auth module and requires an authenticated Bearer session. Body: `{ "path": "/ws" }`. The response is `{ "ticket": "<opaque>", "expiresAt": <Unix seconds> }` with `Cache-Control: no-store`. Supported paths are `/ws`, `/shell`, `/desktop-notifications`, and `/plugin-ws/<safe-name>`.

Tickets contain 32 random bytes, last at most 30 seconds, are bound to the exact path and persistent auth session, and are consumed once, including a wrong-path attempt. Auth caps outstanding tickets at 4,096 globally and eight per session; capacity refusal is HTTP 503 with `Retry-After: 1`, without evicting a live ticket. The gateway consumes through the auth barrel, then checks the live session again. Browser URLs carry only `?ticket=<opaque>`; any legacy `token` query, mixed header/ticket, duplicate ticket/header, unknown parameter, noncanonical route, missing Origin, or invalid principal fails closed. Desktop native capabilities inject a verified session Bearer upstream.

The gateway guards message emission before route listeners and checks outbound frames, absolute expiry, and persistent auth-session validity. A one-second sweep closes idle revoked sockets too. Each chat/shell invocation receives a gateway-owned `isSessionActive` closure; those service owners recheck it across asynchronous side-effect boundaries. Revocation stops future dispatch; already executed external work is not undone.

Defaults: 256 KiB max frame, no compression, 1,024 total connections, 12 per auth session, 120 inbound messages per second, 30-second heartbeat, ten-minute inactivity timeout, and 1 MiB outbound backpressure threshold. Activity includes outbound data so an active provider stream is not mistaken for inactivity. Close grace is bounded at one second. Plugin proxy separately authorizes `authorizePluginAccess(name, userId, 'websocket')` synchronously before port lookup/upstream creation, before every forwarded frame, and every second. Plugin limits: 256 KiB frames, 16 pending frames / 512 KiB pending bytes, 512 KiB send high-water, five-second upstream handshake and one-minute inactivity. Connecting, open, failed, revoked, and closing peers are cleaned up together.

The auth login guard intentionally uses the direct socket peer, not forwarded client IPs. Behind a reverse proxy all clients share its source budget (currently 60 attempts / 15 minutes). Splitting that capacity requires a separately reviewed explicit ingress source contract; deployment must account for the current conservative availability limit.

## Verification

Focused backend checks use the normal Node/tsx runner:

```powershell
node node_modules/tsx/dist/cli.mjs --tsconfig server/tsconfig.json --test server/modules/http-ingress/tests/http-ingress.service.test.ts server/modules/websocket/tests/websocket-heartbeat.service.test.ts server/modules/websocket/tests/websocket-upgrade.service.test.ts server/modules/websocket/tests/websocket-ingress.integration.test.ts server/modules/websocket/tests/plugin-websocket-proxy.service.test.ts
```

Focused browser/native/shell checks:

```powershell
node node_modules/vitest/vitest.mjs run src/shared/tests/webSocketAdmission.test.ts src/shared/tests/desktopWebSocketAccount.test.tsx src/shared/tests/webSocketConnectionStatus.test.tsx src/modules/shell/tests/shellErrorFrame.test.ts src/modules/shell/tests/shellTerminalTheme.test.ts src/modules/shell/tests/shellAdmission.test.ts
```

Real HTTP/WS tests cover public health/login, exact host/origin/CORS and forged proxy headers, ticket expiry/replay/path mismatch, parallel chat/shell/notification/plugin sockets, plugin grant revocation and buffer limits, and existing sockets after logout, password change, and absolute expiry. Frontend tests cover JWT-free URLs, captured-session API dispatch, late tickets, transport/account replacement, connecting sockets, stale direct shell input, platform rejection and retained error/theme behavior. Tests use temporary databases and ephemeral loopback ports only.
