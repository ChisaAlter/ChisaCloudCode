# ChisaCloudCode MyGo desktop

MyGo is the desktop host. The current application frontend lives in the sibling `../cloudcli-ui` directory; `app/src` contains generated native bindings and the older minimal shell.

## Development

Install dependencies once in both `app` and `cloudcli-ui` with `npm install` (or `npm ci` with the existing lockfiles). Use the Go version required by `go.mod`, Node.js 22.12+ (or 24+), and the Windows WebView2 runtime.

From `app`, run:

```powershell
npm run dev
```

This prepares the build identity, starts the sibling frontend on `http://127.0.0.1:5173`, and launches MyGo with Go reload and frontend HMR. Closing the desktop window stops the launcher and its frontend. Ctrl+C stops the process tree created by this launcher. A frontend failure stops this development session and returns a failing exit code.

The frontend uses a strict port: an occupied port produces an actionable error and leaves the existing process running. To keep multiple development sessions, choose another port **and another MyGo project/output directory**; upstream MyGo otherwise writes both builds into the same `.mygo/dev` directory. A single session can use a custom free port as follows:

```powershell
$env:CHISA_DEV_PORT = '5174'
npm run dev
```

The native API proxy binds an available loopback port and advertises it through the bridge. HTTP streams and WebSocket channels use the verified cloud account connection. Cloud development remains the default. Optional SSH-local projects can explicitly configure a native reverse SSH tunnel after login; no tunnel starts during login or session restoration. The desktop has no workspace control listener, local file synchronization or local Pi execution. See [SSH local desktop integration](SSH-LOCAL.md) for native APIs, prerequisites and lifecycle boundaries.

Development application data goes under the user configuration directory in `ChisaCloudCode Dev/sessions/<session-id>`. Each `npm run dev` uses a new session; Go reloads keep that session. The installed app continues using `ChisaCloudCode`. To retain an explicit development profile across launches, set an absolute `CHISA_DATA_DIR` pointing to a separate development directory:

```powershell
$env:CHISA_DATA_DIR = 'C:\dev-profiles\chisa'
npm run dev
```

Do not point a development profile at a running application's profile. MyGo window state and WebView2 storage follow this isolated profile too. An explicit `WEBVIEW2_USER_DATA_FOLDER` override takes precedence.

For deliberately separate processes, `npm run dev:web` starts only the managed sibling frontend, and `npm run dev:native` starts MyGo using that frontend. Both commands use `CHISA_DEV_PORT`. The recommended single command is `npm run dev`, which monitors both lifetimes. Running `mygo dev` directly also uses the EOF-safe frontend runner, but MyGo 0.1.22 only checks frontend exit while waiting for the first HTTP response.

The Vite runner explicitly ignores stdin EOF because MyGo launches devCommand without stdin. On Windows it uses polling and ignores atomic-save temporary paths to avoid `fs.watch` EBUSY crashes during edits.

## Build and checks

```powershell
npm run typecheck
npm run build
```

The build prepares the identity, runs the sibling frontend's builtin-plugin build hook, then invokes its Vite build. Synchronization engines, agent bundles and bundled SSH executables are excluded, including stale copies in a reused staging directory. The on-demand PowerShell SSH workspace helper is embedded in the native binary; installation to application data requires an explicit action. MyGo embeds `../cloudcli-ui/dist`; the installer step runs after the native build. The build runner uses Node and the frontend's Vite API without a nested npm shell.

Native verification:

```powershell
go test . -count=1 -timeout=600s
go vet .
go build -o build/cloud-only-check.exe .
```

Historical mapping and Pi/session files remain on disk. Old native sync, mapping mutation, Pi and desktop preview RPCs return `CLOUD_ONLY_DESKTOP`; both API proxy paths reject `/api/workspace-sync` with HTTP 410. Cloud runtime APIs remain available.

At startup, a bounded migration can query an already running legacy Mutagen daemon through the existing profile's local IPC endpoint. The client supports only daemon version metadata, synchronization metadata and exact-session pause; it imports no synchronization engine and launches no external process. It verifies a known 0.18.1 / Chisa .1–.5 protocol, the persisted mapping epoch/name and both endpoint identities, then pauses only the full immutable session identifier and rechecks its paused state. It never uses a batch mutation, stops a whole daemon, changes SSH keys, deletes a project or rewrites a legacy mapping. Unrecognized sessions, unsupported versions and failed verification remain untouched and are reported by `GetState().legacySyncRetirement` and the application log; they do not block cloud login.

The root Go package is the active native application. Recursive `./...` checks also discover historical source snapshots under `build/`; some snapshots lack their old embedded workers and are not current product packages.

A temporary startup probe can use `npm run dev -- --smoke-seconds=15`; it closes only that launcher's child processes after the timeout. The timeout starts after the frontend is ready, so choose a longer duration on a cold Go build.
