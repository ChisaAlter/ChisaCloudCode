# MyGo desktop host

ChisaCloudCode uses **MyGo as its only desktop host**. The web application is the shared React workspace, and `mygo-runtime` is the frontend bridge used to call native desktop capabilities.

## Runtime ownership

- **MyGo host** owns the desktop window, verified account connections, API/WebSocket proxy, diagnostics, desktop lifecycle, and explicitly configured SSH reverse tunnels. Retired folder synchronization and local Pi execution remain removed; optional SSH directory selection uses separate native methods.
- **`mygo-runtime`** provides the frontend call/event bridge. Application code calls the generated `FrontendBridge` wrapper in `src/shared/chisa.ts`; it does not talk to a desktop implementation directly.
- **The React/Vite application** owns the Claude Code style workspace UI, routing, chat state, project views, settings, and browser compatible HTTP/WebSocket behavior.
- **The Node server** owns project target resolution, Git/file/terminal gateways, providers, cloud session workspaces, integration, and previews. Cloud targets retain their runtime; SSH targets use the pinned Windows transport while Claude Code stays on the VPS. The desktop is a client of these REST/WebSocket APIs.

## Startup contract

The MyGo desktop entry loads the shared React application and provides `globalThis.mygo` before React starts. Authentication determines the first surface: a clean or signed-out profile shows the desktop account login surface; a valid restored session enters the existing project workspace route. Successful account login enters that same workspace. Desktop startup must preserve account authorization and must not bypass authentication to force a workspace route.

The frontend uses `isDesktop()` to detect the MyGo bridge and `FrontendBridge` methods for native capabilities. Code that only needs HTTP or WebSocket access should remain browser compatible and use the current page origin or the configured server connection. Cloud project selection and creation use server directories or server-side Git clone without native SSH calls. SSH local projects may use the separate native directory picker, connection catalog, explicit tunnel controls and actual server-side probe. Neither mode requires repository synchronization. See [SSH local setup](ssh-local-workspaces.zh-CN.md).

## Desktop boundary

Electron is not part of this project architecture or release process. Do not add Electron preload code, BrowserView wrappers, Electron Builder metadata, Electron-specific staging, or a second desktop authentication path. If a native desktop capability is needed, add it to the MyGo host contract and expose the smallest corresponding `FrontendBridge` method.

The server can still run as a normal Node process for self-hosted browser use. Production cloud execution restores its own account network without creating an SSH synchronization sidecar. Upgrades stop only a verified account-owned legacy synchronization container and preserve its project files.

## Validation checklist

When changing desktop behavior, verify:

1. MyGo injects `globalThis.mygo` before the app bootstraps.
2. A clean profile shows the signed-out desktop account surface, a valid restored session enters the existing workspace, and successful login enters that workspace without a separate desktop authentication path.
3. Native calls go through `mygo-runtime` and the `FrontendBridge` wrapper.
4. Browser and local Node server behavior still works without a MyGo bridge.
5. No Electron source, package script, dependency, or build artifact is introduced.
