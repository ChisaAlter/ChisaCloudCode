import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { getAuthSessionSnapshot, subscribeToAuthSession } from '@/modules/auth-session';
import { createPluginSessionBridge } from '@/modules/plugins/pluginSessionBridge';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import type { Plugin, Project, ProjectSession, WorkspaceDescriptor } from '@/shared/types';
import { useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';

type PluginTabContentProps = { pluginName: string; selectedProject: Project | null; selectedSession: ProjectSession | null };
type PluginContext = {
  theme: 'dark' | 'light';
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
  workspace: WorkspaceDescriptor | null;
};
function buildContext(dark: boolean, project: Project | null, session: ProjectSession | null, workspace: WorkspaceDescriptor | null | undefined): PluginContext {
  return { theme: dark ? 'dark' : 'light', workspace: workspace ?? null,
    project: project ? { name: project.projectId, path: project.fullPath || project.path || '' } : null,
    session: session ? { id: session.id, title: session.title || session.name || session.id } : null };
}

/** Workspace and quota tabs run only reviewed trusted extensions; the iframe is a styling boundary, never an untrusted-code sandbox. */
export default function PluginTabContent({ pluginName, selectedProject, selectedSession }: PluginTabContentProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  // Only the currently mounted trusted frame may publish a loading failure.
  const [loadError, setLoadError] = useState<string | null>(null);
  const { isDarkMode } = useTheme();
  const { plugins } = usePlugins();
  const workspace = useWorkspaceScope();
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  const contextRef = useRef(buildContext(isDarkMode, selectedProject, selectedSession, workspace));
  const callbacksRef = useRef(new Set<(context: PluginContext) => void>());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const candidate = plugins.find(item => item.name === pluginName);
  // Catalog refresh/token rotation must not restart a trusted plugin with unchanged executable identity.
  const executableRef = useRef<{ key: string; plugin: Plugin; session: typeof session } | null>(null);
  const executableKey = JSON.stringify([candidate?.entry, candidate?.enabled, candidate?.displayName, candidate?.security,
    session.sessionInstanceId, session.serverKey, session.phase]);
  if (candidate && executableRef.current?.key !== executableKey) executableRef.current = { key: executableKey, plugin: candidate, session };
  if (!candidate) executableRef.current = null;
  const plugin = executableRef.current?.plugin;
  const frameSession = executableRef.current?.session;
  const permitted = plugin?.security?.model === 'trusted-only' && plugin.security.trusted && plugin.security.permitted;

  useEffect(() => {
    contextRef.current = buildContext(isDarkMode, selectedProject, selectedSession, workspace);
    const root = frameRef.current?.contentDocument?.documentElement;
    if (root) {
      root.classList.toggle('dark', isDarkMode);
      const styles = getComputedStyle(document.documentElement);
      for (const name of ['--background', '--card', '--border', '--foreground', '--muted-foreground', '--primary']) root.style.setProperty(name, styles.getPropertyValue(name));
    }
    for (const callback of callbacksRef.current) {
      try { callback(contextRef.current); } catch (error) { setLoadError(String(error)); }
    }
  }, [isDarkMode, selectedProject, selectedSession, workspace]);

  useEffect(() => {
    setLoadError(null);
    if (!containerRef.current || !plugin?.enabled || frameSession?.phase !== 'ready') return;
    if (!permitted) { setLoadError('This plugin version has not been explicitly trusted and permitted. Review it in plugin settings.'); return; }
    const captured = frameSession;
    const bridge = createPluginSessionBridge(plugin, captured);
    const controller = new AbortController();
    let active = true;
    let entryUrl: string | null = null;
    const callbacks = new Set<(context: PluginContext) => void>();
    callbacksRef.current = callbacks;
    const frame = document.createElement('iframe');
    frameRef.current = frame;
    frame.title = plugin.displayName;
    frame.className = 'h-full min-h-80 w-full border-0';
    // Trusted extensions retain existing clipboard/storage behavior. No untrusted plugin reaches this branch.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    const ready = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }));
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#plugin-root{height:100%;margin:0;width:100%}body{font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body><div id="plugin-root"></div></body></html>';
    containerRef.current.appendChild(frame);
    type FrameWindow = Window & {
      chisaPluginDispose?: () => void;
      chisaPluginHostApi?: { readonly context: PluginContext; onContextChange(callback: (context: PluginContext) => void): () => void;
        rpc(method: string, path: string, body?: unknown): Promise<unknown>; reportError(error: unknown): void };
      chisaPluginWebSocketUrl?: (name: string) => string;
    };
    let admittedDocument: Document | null = null;
    const assertFrame = () => {
      bridge.assertCurrent();
      if (!active || frameRef.current !== frame || !frame.contentWindow || frame.contentWindow.frameElement !== frame
        || (admittedDocument && frame.contentDocument !== admittedDocument)) throw new DOMException('Plugin frame ended', 'AbortError');
      // Accessing the parent origin fails for a navigated cross-origin document; never accept a substituted frame source.
      if (frame.contentWindow.parent.location.origin !== window.location.origin) throw new DOMException('Plugin frame origin changed', 'SecurityError');
    };
    void (async () => {
      try {
        const response = await api.plugins.asset(pluginName, plugin.entry, { expectedSession: captured, signal: controller.signal });
        if (!response.ok) throw new Error(`Failed to fetch plugin (HTTP ${response.status})`);
        const source = await response.text();
        await ready;
        assertFrame();
        if (!frame.contentDocument || !frame.contentWindow) return;
        admittedDocument = frame.contentDocument;
        const frameWindow = frame.contentWindow as FrameWindow;
        frame.contentDocument.documentElement.classList.toggle('dark', contextRef.current.theme === 'dark');
        const styles = getComputedStyle(document.documentElement);
        for (const name of ['--background', '--card', '--border', '--foreground', '--muted-foreground', '--primary']) frame.contentDocument.documentElement.style.setProperty(name, styles.getPropertyValue(name));
        // No postMessage listener accepts ambient messages: the exact frame receives revocable closures, with validated inputs.
        frameWindow.chisaPluginHostApi = Object.freeze({
          get context() { assertFrame(); return structuredClone(contextRef.current); },
          onContextChange(callback: (context: PluginContext) => void) {
            assertFrame(); if (typeof callback !== 'function') throw new TypeError('Invalid context callback');
            const notify = (context: PluginContext) => { assertFrame(); callback(structuredClone(context)); };
            callbacks.add(notify); return () => callbacks.delete(notify);
          },
          rpc(method: string, path: string, body?: unknown) { assertFrame(); return bridge.request(method, path, body); },
          reportError(error: unknown) { if (active) setLoadError(String(error)); },
        });
        // Fetch is plugin-relative and uses the captured session. There is no credential-reading host function.
        frameWindow.fetch = (input, init) => { assertFrame(); return bridge.fetch(input, init); };
        const socketAlias = `chisa-plugin://${encodeURIComponent(pluginName)}`;
        frameWindow.chisaPluginWebSocketUrl = name => {
          assertFrame(); if (name !== pluginName || !plugin.security?.permissions.includes('host:websocket')) throw new Error('Plugin websocket capability is not granted');
          return socketAlias;
        };
        class PluginSocket extends EventTarget {
          static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
          CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
          readyState = 0; bufferedAmount = 0; binaryType = 'blob'; protocol = ''; extensions = ''; url = socketAlias;
          onopen: ((event: Event) => void) | null = null;
          onmessage: ((event: MessageEvent) => void) | null = null;
          onclose: ((event: CloseEvent) => void) | null = null;
          onerror: ((event: Event) => void) | null = null;
          private connection: Awaited<ReturnType<typeof bridge.openSocket>> | null = null;
          constructor(url: string | URL) {
            super(); assertFrame();
            if (String(url) !== socketAlias) throw new TypeError('Plugin sockets must use their granted host capability');
            void bridge.openSocket({
              open: () => { if (this.readyState !== 0) return; this.readyState = 1; const event = new Event('open'); this.dispatchEvent(event); this.onopen?.(event); },
              message: data => { if (this.readyState !== 1) return; const event = new MessageEvent('message', { data }); this.dispatchEvent(event); this.onmessage?.(event); },
              close: (code, reason) => { this.readyState = 3; const event = new CloseEvent('close', { code, reason }); this.dispatchEvent(event); this.onclose?.(event); },
              error: () => { const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event); },
            }).then(connection => { this.connection = connection; if (this.readyState >= 2) connection.close(); }, () => {
              this.readyState = 3; const event = new Event('error'); this.dispatchEvent(event); this.onerror?.(event);
              const closed = new CloseEvent('close', { code: 1006 }); this.dispatchEvent(closed); this.onclose?.(closed);
            });
          }
          send(data: unknown) { assertFrame(); if (this.readyState !== 1 || !this.connection) throw new Error('Plugin socket is not open'); this.connection.send(data); }
          close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 2; this.connection?.close(code, reason); }
        }
        Object.defineProperty(frameWindow, 'WebSocket', { value: PluginSocket, configurable: true });
        entryUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        const script = frame.contentDocument.createElement('script');
        script.type = 'module';
        script.textContent = `const api=window.chisaPluginHostApi;const root=document.getElementById('plugin-root');try{const plugin=await import(${JSON.stringify(entryUrl)});window.chisaPluginDispose=()=>plugin.unmount?.(root);await plugin.mount?.(root,api);}catch(error){api.reportError(error);}`;
        frame.contentDocument.body.appendChild(script);
      } catch (error) { if (active && !controller.signal.aborted) setLoadError(String(error)); }
    })();
    return () => {
      active = false; controller.abort(); bridge.dispose();
      try { (frame.contentWindow as FrameWindow | null)?.chisaPluginDispose?.(); } catch { /* Removal still drops the trusted document. */ }
      callbacks.clear(); frame.remove();
      if (frameRef.current === frame) frameRef.current = null;
      if (entryUrl) URL.revokeObjectURL(entryUrl);
    };
  }, [pluginName, plugin, permitted, frameSession]);

  return <div className="relative h-full min-h-80 w-full overflow-auto">
    <div ref={containerRef} className="h-full min-h-80 w-full" />
    {loadError && <div role="alert" className="absolute inset-0 bg-background p-4 text-[13px] text-destructive">{t('common:misc.pluginLoadFailed', { error: loadError })}</div>}
  </div>;
}
