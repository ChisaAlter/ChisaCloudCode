import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTheme } from '@/shared/context/ThemeContext';
import { api } from '@/shared/api';
import { usePlugins } from '@/modules/plugins/context/PluginsContext';
import type { Project, ProjectSession, WorkspaceDescriptor } from '@/shared/types';
import { useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';

type PluginTabContentProps = {
  pluginName: string;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
};

type PluginContext = {
  theme: 'dark' | 'light';
  // The plugin contract uses name as the stable project identifier.
  project: { name: string; path: string } | null;
  session: { id: string; title: string } | null;
  workspace: WorkspaceDescriptor | null;
};

function buildContext(isDarkMode: boolean, selectedProject: Project | null, selectedSession: ProjectSession | null, workspace: WorkspaceDescriptor | null | undefined): PluginContext {
  return {
    theme: isDarkMode ? 'dark' : 'light',
    workspace: workspace ?? null,
    project: selectedProject ? { name: selectedProject.projectId, path: selectedProject.fullPath || selectedProject.path || '' } : null,
    session: selectedSession ? { id: selectedSession.id, title: selectedSession.title || selectedSession.name || selectedSession.id } : null,
  };
}

/** Workspace tabs and the account popup host bundled plugins in separate documents. */
export default function PluginTabContent({ pluginName, selectedProject, selectedSession }: PluginTabContentProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  // Show only failures from the currently mounted plugin frame.
  const [loadError, setLoadError] = useState<string | null>(null);
  const { isDarkMode } = useTheme();
  const { plugins } = usePlugins();
  const workspace = useWorkspaceScope();
  const contextRef = useRef<PluginContext>(buildContext(isDarkMode, selectedProject, selectedSession, workspace));
  const contextCallbacksRef = useRef(new Set<(context: PluginContext) => void>());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const plugin = plugins.find((candidate) => candidate.name === pluginName);

  useEffect(() => {
    const context = buildContext(isDarkMode, selectedProject, selectedSession, workspace);
    contextRef.current = context;
    const root = frameRef.current?.contentDocument?.documentElement;
    if (root) {
      root.classList.toggle('dark', isDarkMode);
      const hostStyles = getComputedStyle(document.documentElement);
      for (const name of ['--background', '--card', '--border', '--foreground', '--muted-foreground', '--primary']) {
        root.style.setProperty(name, hostStyles.getPropertyValue(name));
      }
    }
    for (const callback of contextCallbacksRef.current) {
      try { callback(context); } catch (error) { setLoadError(String(error)); }
    }
  }, [isDarkMode, selectedProject, selectedSession, workspace]);

  useEffect(() => {
    setLoadError(null);
    if (!containerRef.current || !plugin?.enabled) return;
    let active = true;
    let entryUrl: string | null = null;
    const callbacks = new Set<(context: PluginContext) => void>();
    contextCallbacksRef.current = callbacks;
    const frame = document.createElement('iframe');
    frameRef.current = frame;
    frame.title = plugin.displayName;
    frame.className = 'h-full min-h-[20rem] w-full border-0';
    // Isolation confines plugin body overlays, style IDs and module singletons
    // to this document. Same-origin retains clipboard/storage and host callbacks.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    frame.setAttribute('allow', 'clipboard-read; clipboard-write');
    const frameReady = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
    frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#plugin-root{height:100%;margin:0;width:100%}body{font-family:system-ui,sans-serif}*{box-sizing:border-box}</style></head><body><div id="plugin-root"></div></body></html>';
    containerRef.current.appendChild(frame);
    type FrameWindow = Window & {
      chisaPluginWebSocketUrl?: (name: string) => string;
      chisaPluginDispose?: () => void;
      chisaPluginHostApi?: {
        readonly context: PluginContext;
        onContextChange(callback: (context: PluginContext) => void): () => void;
        rpc(method: string, requestPath: string, body?: unknown): Promise<unknown>;
        reportError(error: unknown): void;
      };
    };

    void (async () => {
      try {
        const response = await api.plugins.asset(pluginName, plugin.entry);
        if (!response.ok) throw new Error(`Failed to fetch plugin (HTTP ${response.status})`);
        const source = await response.text();
        await frameReady;
        if (!active || !frame.contentWindow || !frame.contentDocument) return;
        const frameWindow = frame.contentWindow as FrameWindow;
        frame.contentDocument.documentElement.classList.toggle('dark', contextRef.current.theme === 'dark');
        const hostStyles = getComputedStyle(document.documentElement);
        for (const name of ['--background', '--card', '--border', '--foreground', '--muted-foreground', '--primary']) {
          frame.contentDocument.documentElement.style.setProperty(name, hostStyles.getPropertyValue(name));
        }
        frameWindow.chisaPluginWebSocketUrl = api.plugins.webSocketUrl;
        frameWindow.chisaPluginHostApi = {
          get context() { return contextRef.current; },
          onContextChange(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
          async rpc(method, requestPath, body) {
            const result = await api.plugins.rpc(pluginName, method, requestPath, body);
            const data = await result.json();
            if (!result.ok) {
              const message = typeof data.error === 'string' ? data.error : data.error?.message;
              throw new Error(message || `RPC error ${result.status}`);
            }
            return data;
          },
          reportError(error) { if (active) setLoadError(String(error)); },
        };
        entryUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        const script = frame.contentDocument.createElement('script');
        script.type = 'module';
        script.textContent = `
          const api = window.chisaPluginHostApi;
          const container = document.getElementById('plugin-root');
          try {
            const plugin = await import(${JSON.stringify(entryUrl)});
            window.chisaPluginDispose = () => plugin.unmount?.(container);
            await plugin.mount?.(container, api);
          } catch (error) { api.reportError(error); }
        `;
        frame.contentDocument.body.appendChild(script);
      } catch (error) {
        if (active) setLoadError(String(error));
      }
    })();

    return () => {
      active = false;
      const frameWindow = frame.contentWindow as FrameWindow | null;
      try { frameWindow?.chisaPluginDispose?.(); } catch { /* Removing the document still disposes its timers and listeners. */ }
      callbacks.clear();
      frame.remove();
      if (frameRef.current === frame) frameRef.current = null;
      if (entryUrl) URL.revokeObjectURL(entryUrl);
    };
  }, [pluginName, plugin?.entry, plugin?.enabled, plugin?.displayName]);

  return (
    <div className="relative h-full min-h-[20rem] w-full overflow-auto">
      <div ref={containerRef} className="h-full min-h-[20rem] w-full" />
      {loadError && <div role="alert" className="absolute inset-0 bg-background p-4 text-[13px] text-destructive">{t('common:misc.pluginLoadFailed', { error: loadError })}</div>}
    </div>
  );
}
