# ChisaCloudCode MyGo desktop

MyGo is the desktop host. The current application frontend lives in the sibling `../cloudcli-ui` directory; `app/src` contains generated native bindings and the older minimal shell.

The public distribution leaves `resources/service.json` with empty `loginUrl` and `caCertificate` defaults. Connect to your own HTTPS account service; keep deployment configuration, accounts, credentials, and generated artifacts outside the repository.

Build prerequisites and externally supplied synchronization binaries are documented in the [repository README](../README.md) and [runtime dependency manifest](../runtime-dependencies.json). Provision the verified engine and agents described there before building; the runtime binaries are not vendored into `app`. The repository [license](../LICENSE) and [notices](../NOTICE) apply to this desktop host.

## Development

Install dependencies once in both `app` and `cloudcli-ui` with `npm install` (or `npm ci` with the existing lockfiles). Use the Go version required by `go.mod`, Node.js 22.12+ (or 24+), and the Windows WebView2 runtime.

From `app`, run:

```powershell
npm run dev
```

This prepares the native SSH helper and build identity, starts the sibling frontend on `http://127.0.0.1:5173`, and launches MyGo with Go reload and frontend HMR. Closing the desktop window stops the launcher and its frontend. Ctrl+C stops the process tree created by this launcher. A frontend failure stops this development session and returns a failing exit code.

The frontend uses a strict port: an occupied port produces an actionable error and leaves the existing process running. To keep multiple development sessions, choose another port **and another MyGo project/output directory**; upstream MyGo otherwise writes both builds into the same `.mygo/dev` directory. A single session can use a custom free port as follows:

```powershell
$env:CHISA_DEV_PORT = '5174'
npm run dev
```

MyGo's native API proxy and workspace control listener bind independently allocated loopback ports. The bridge advertises the actual API port, and workspace SSH forwarding receives the actual control port. They can coexist with a running installed application and with an older development build during hot reload. The legacy SSH account tunnel still uses its existing local port; do not connect multiple independent desktop profiles to that same tunnel concurrently.

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

The build prepares the native SSH helper and identity, runs the sibling frontend's builtin-plugin build hook, then invokes its Vite build. MyGo embeds `../cloudcli-ui/dist`; the installer step runs after the native build. The build runner uses Node and the frontend's Vite API without a nested npm shell.

Targeted startup regression checks:

```powershell
go test . -run 'TestStartup|TestServerConnection|TestAPIProxy' -count=1
```

A temporary startup probe can use `npm run dev -- --smoke-seconds=15`; it closes only that launcher's child processes after the timeout. The timeout starts after the frontend is ready, so choose a longer duration on a cold Go build.
