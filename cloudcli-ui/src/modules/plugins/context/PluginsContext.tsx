import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { api, readApiErrorMessage } from '@/shared/api';
import type { Plugin } from '@/shared/types';
import { useAuth } from '@/modules/auth';
import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';


type PluginsContextValue = {
  plugins: Plugin[];
  loading: boolean;
  pluginsError: string | null;
  refreshPlugins: () => Promise<void>;
  togglePlugin: (name: string, enabled: boolean, approval?: Parameters<typeof api.plugins.toggle>[2]) => Promise<{ success: boolean; error: string | null }>;
};

const PluginsContext = createContext<PluginsContextValue | null>(null);

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
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  // Keep the authenticated server's plugin catalog available to workspace consumers.
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  // The catalog waits for login before the first protected request.
  const [loading, setLoading] = useState(true);
  // API diagnostics remain renderable text so a failed refresh preserves settings.
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const catalogGenerationRef = useRef(0);
  // Rendering exposes catalog data only to the exact identity that requested it, including same-user relogin.
  const [catalogOwner, setCatalogOwner] = useState('');
  const catalogOwnerKey = JSON.stringify([session.serverKey, session.sessionInstanceId, user?.id, user?.username]);
  const catalogRequestRef = useRef(0);

  const refreshPlugins = useCallback(async () => {
    const captured = getAuthSessionSnapshot();
    const generation = catalogGenerationRef.current;
    const request = ++catalogRequestRef.current;
    const current = () => isCurrentAuthSession(captured) && generation === catalogGenerationRef.current && request === catalogRequestRef.current;
    setLoading(true);
    try {
      const res = await api.plugins.list({ expectedSession: captured });
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
          errorMessage = readApiErrorMessage(data) ?? errorMessage;
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

  const hasUser = Boolean(user);
  useEffect(() => {
    const generation = ++catalogGenerationRef.current;
    const capturedSession = getAuthSessionSnapshot();
    setCatalogOwner(catalogOwnerKey);
    // A different account must never inherit another account's catalog or quota view.
    setPlugins([]);
    setPluginsError(null);
    if (!authLoading) {
      if (!hasUser || capturedSession.phase !== 'ready') setLoading(false);
      else { setLoading(true); void refreshPlugins(); }
    }
    const invalidate = () => { if (catalogGenerationRef.current === generation) catalogGenerationRef.current = generation + 1; };
    return invalidate;
  }, [user?.id, user?.username, hasUser, authLoading, refreshPlugins, session.sessionInstanceId, session.serverKey, session.phase, catalogOwnerKey]);

  const togglePlugin = useCallback(async (name: string, enabled: boolean, approval?: Parameters<typeof api.plugins.toggle>[2]): Promise<{ success: boolean; error: string | null }> => {
    const captured = session;
    try {
      if (!isCurrentAuthSession(captured) || captured.phase !== 'ready') throw new DOMException('Plugin account session changed', 'AbortError');
      const res = await api.plugins.toggle(name, enabled, approval, { expectedSession: captured });
      if (!isCurrentAuthSession(captured)) throw new DOMException('Plugin account session changed', 'AbortError');
      if (!res.ok) {
        let errorMessage = `Toggle failed (${res.status})`;
        try {
          const data = await res.json();
          errorMessage = readApiErrorMessage(data) ?? errorMessage;
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
  }, [refreshPlugins, session]);

  // Built once per change: an inline object would re-render every consumer on
  // any render of this provider.
  const value = useMemo(
    () => ({ plugins: session.phase === 'ready' && catalogOwner === catalogOwnerKey ? plugins : [], loading,
      pluginsError: catalogOwner === catalogOwnerKey ? pluginsError : null, refreshPlugins, togglePlugin }),
    [loading, plugins, catalogOwner, catalogOwnerKey, session.phase, pluginsError, refreshPlugins, togglePlugin],
  );

  return (
    <PluginsContext.Provider value={value}>
      {children}
    </PluginsContext.Provider>
  );
}
