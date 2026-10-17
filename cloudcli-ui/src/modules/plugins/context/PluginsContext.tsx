import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { api } from '@/shared/api';
import type { Plugin } from '@/shared/types';
import { useAuth } from '@/modules/auth';


type PluginsContextValue = {
  plugins: Plugin[];
  loading: boolean;
  pluginsError: string | null;
  refreshPlugins: () => Promise<void>;
  togglePlugin: (name: string, enabled: boolean) => Promise<{ success: boolean; error: string | null }>;
};

const PluginsContext = createContext<PluginsContextValue | null>(null);

// The server returns both legacy text errors and { error: { message, code } }.
// Only text may enter plugin error state, which is rendered directly by React.
function pluginErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const payload = data as Record<string, unknown>;
  if (typeof payload.details === 'string' && payload.details) return payload.details;
  if (typeof payload.error === 'string' && payload.error) return payload.error;
  if (payload.error && typeof payload.error === 'object') {
    const error = payload.error as Record<string, unknown>;
    if (typeof error.message === 'string' && error.message) return error.message;
  }
  return fallback;
}

export function usePlugins() {
  const context = useContext(PluginsContext);
  if (!context) {
    throw new Error('usePlugins must be used within a PluginsProvider');
  }
  return context;
}

/** App root supplies plugin switches to settings, workspace tabs and the account popup. */
export function PluginsProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: authLoading } = useAuth();
  // Keep the authenticated server's plugin catalog available to workspace consumers.
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  // The catalog waits for login before the first protected request.
  const [loading, setLoading] = useState(true);
  // API diagnostics remain renderable text so a failed refresh preserves settings.
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const catalogGenerationRef = useRef(0);
  const catalogRequestRef = useRef(0);

  const refreshPlugins = useCallback(async () => {
    const generation = catalogGenerationRef.current;
    const request = ++catalogRequestRef.current;
    const current = () => generation === catalogGenerationRef.current && request === catalogRequestRef.current;
    setLoading(true);
    try {
      const res = await api.plugins.list();
      if (!current()) return;
      if (res.ok) {
        const data = await res.json();
        if (!current()) return;
        setPlugins(data.plugins || []);
        setPluginsError(null);
      } else {
        let errorMessage = `Failed to fetch plugins (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = pluginErrorMessage(data, errorMessage);
        } catch {
          errorMessage = res.statusText || errorMessage;
        }
        if (current()) setPluginsError(errorMessage);
      }
    } catch (err) {
      if (!current()) return;
      const message = err instanceof Error ? err.message : 'Failed to fetch plugins';
      setPluginsError(message);
      console.error('[Plugins] Failed to fetch plugins:', err);
    } finally {
      if (current()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    catalogGenerationRef.current++;
    // A different account must never inherit another account's catalog or quota view.
    setPlugins([]);
    setPluginsError(null);
    if (authLoading) return;
    if (!user) {
      setPlugins([]);
      setPluginsError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void refreshPlugins();
    return () => { catalogGenerationRef.current++; };
  }, [user?.id, user?.username, authLoading, refreshPlugins]);

  const togglePlugin = useCallback(async (name: string, enabled: boolean): Promise<{ success: boolean; error: string | null }> => {
    try {
      const res = await api.plugins.toggle(name, enabled);
      if (!res.ok) {
        let errorMessage = `Toggle failed (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = pluginErrorMessage(data, errorMessage);
        } catch {
          // response body wasn't JSON, use status text
          errorMessage = res.statusText || errorMessage;
        }
        return { success: false, error: errorMessage };
      }
      await refreshPlugins();
      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Toggle failed' };
    }
  }, [refreshPlugins]);

  // Built once per change: an inline object would re-render every consumer on
  // any render of this provider.
  const value = useMemo(
    () => ({ plugins, loading, pluginsError, refreshPlugins, togglePlugin }),
    [loading, plugins, pluginsError, refreshPlugins, togglePlugin],
  );

  return (
    <PluginsContext.Provider value={value}>
      {children}
    </PluginsContext.Provider>
  );
}
