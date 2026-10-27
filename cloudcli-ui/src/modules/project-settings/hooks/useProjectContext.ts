import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import type { ProjectContextView } from '@/shared/types';

/** Reads project policy and the latest actual run manifest while the context panel is mounted. */
export function useProjectContext(projectId: string | null | undefined, enabled = true) {
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();
  const key = JSON.stringify([projectId, enabled, authVersion, serverVersion]);
  // Bind the last successful read and refresh feedback to the exact account, service and project.
  const [snapshot, setSnapshot] = useState<{ key: string; view: ProjectContextView | null; isLoading: boolean; error: string | null }>({ key, view: null, isLoading: Boolean(projectId && enabled), error: null });
  const requestRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (authVersion !== getAuthSessionVersion() || serverVersion !== getServerConnectionVersion()) return;
    controllerRef.current?.abort();
    const request = ++requestRef.current;
    if (!projectId || !enabled) {
      setSnapshot({ key, view: null, isLoading: false, error: null });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    const current = () => !controller.signal.aborted && request === requestRef.current && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
    setSnapshot(previous => ({ key, view: previous.key === key ? previous.view : null, isLoading: true, error: null }));
    try {
      const response = await api.projectContext(projectId, { signal: controller.signal });
      const payload = (await response.json()) as { data?: ProjectContextView; error?: string | { message?: string } };
      if (!current()) return;
      if (!response.ok || !payload.data || payload.data.projectId !== projectId) {
        throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || '无法读取项目运行上下文，请重试。');
      }
      setSnapshot({ key, view: payload.data, isLoading: false, error: null });
    } catch (failure) {
      if (current()) setSnapshot(previous => ({ key, view: previous.key === key ? previous.view : null, isLoading: false, error: failure instanceof Error ? failure.message : '无法读取项目运行上下文，请重试。' }));
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [authVersion, enabled, key, projectId, serverVersion]);

  useEffect(() => {
    void refresh();
    // The context tab unmounts when closed; background reads never overlap an unfinished request.
    const timer = enabled && projectId ? window.setInterval(() => {
      if (document.visibilityState !== 'hidden' && !controllerRef.current) void refresh();
    }, 5000) : undefined;
    return () => { window.clearInterval(timer); ++requestRef.current; controllerRef.current?.abort(); controllerRef.current = null; };
  }, [enabled, projectId, refresh]);

  const owned = snapshot.key === key && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
  return { view: owned ? snapshot.view : null, isLoading: owned ? snapshot.isLoading : Boolean(projectId && enabled), error: owned ? snapshot.error : null, refresh };
}
