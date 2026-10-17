import { useEffect, useRef } from 'react';

import { mount, unmount } from '@builtin-plugins/claude-usage/src/index';
import type { PluginContext } from '@builtin-plugins/claude-usage/src/types';
import { api, readApiJson } from '@/shared/api';
import { useTheme } from '@/shared/context/ThemeContext';

/** Account usage is bundled UI; only its data comes from the authenticated VPS. */
export function ClaudeUsagePanel() {
  const { isDarkMode } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<PluginContext>({ theme: isDarkMode ? 'dark' : 'light', project: null, session: null });
  const listenersRef = useRef(new Set<(context: PluginContext) => void>());

  useEffect(() => {
    const context: PluginContext = { theme: isDarkMode ? 'dark' : 'light', project: null, session: null };
    contextRef.current = context;
    for (const listener of listenersRef.current) listener(context);
  }, [isDarkMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const listeners = listenersRef.current;
    // Unlike arbitrary plugin tabs, this fixed account surface needs no remote
    // module fetch, srcdoc document load, or inline-module bootstrap.
    mount(container, {
      get context() { return contextRef.current; },
      onContextChange(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      async rpc(method, path, body) {
        return readApiJson(await api.plugins.rpc('claude-usage', method, path, body));
      },
    });
    return () => {
      unmount(container);
      listeners.clear();
    };
  }, []);

  return <div ref={containerRef} className="min-h-80 w-full" />;
}
