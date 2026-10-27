import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { getAuthSessionVersion } from '@/shared/authToken';
import { getServerConnectionVersion } from '@/shared/chisa';
import type { WorkspaceDescriptor, WorkspaceResolution } from '@/shared/types';

function validWorkspace(value: WorkspaceDescriptor | null | undefined, projectId: string, kind: WorkspaceDescriptor['kind'], sessionId?: string) {
  return value && value.projectId === projectId && value.kind === kind && Boolean(value.workspaceId && value.generation && value.rootPath)
    && (kind !== 'session' || value.sessionId === sessionId) && value.capabilities
    && ['read', 'write', 'git', 'shell', 'preview', 'integrate', 'cloudExecutionIndependentOfDesktop'].every(key => typeof value.capabilities[key as keyof WorkspaceDescriptor['capabilities']] === 'boolean');
}

/** WorkspaceMain resolves authoritative identities; pending/failed reads cannot retain write capabilities. */
export function useWorkspaceResolution(projectId?: string, sessionId?: string, connectionRevision = 0) {
  const authVersion = getAuthSessionVersion();
  const serverVersion = getServerConnectionVersion();
  const key = JSON.stringify([authVersion, serverVersion, projectId, sessionId]);
  // Only a completed response for the current identity can grant workspace capabilities.
  const [snapshot, setSnapshot] = useState<{ key: string; value: WorkspaceResolution | null; error: string | null; pending: boolean } | null>(null);
  // Explicit refresh replaces pending reads without replaying any workspace mutation.
  const [refreshVersion, setRefreshVersion] = useState(0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const refresh = useCallback(() => setRefreshVersion(value => value + 1), []);

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    let pending = false;
    const current = () => !controller.signal.aborted && keyRef.current === key && authVersion === getAuthSessionVersion() && serverVersion === getServerConnectionVersion();
    setSnapshot({ key, value: null, error: null, pending: true });
    const load = async () => {
      if (pending || !current()) return;
      pending = true;
      const request = new AbortController();
      const cancel = () => request.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      const timeout = window.setTimeout(() => request.abort(new DOMException('读取工作区状态超时，请刷新重试', 'TimeoutError')), 15000);
      try {
        const response = await api.workspaces.resolve(projectId, sessionId, { signal: request.signal });
        const value = await readApiJson<WorkspaceResolution>(response);
        if (!validWorkspace(value.cloudReplica, projectId, 'cloudReplica') || (value.session && !validWorkspace(value.session, projectId, 'session', sessionId))) throw new Error('工作区身份无效，请刷新重试');
        if (current()) setSnapshot({ key, value, error: null, pending: false });
      } catch (error) {
        if (current()) setSnapshot({ key, value: null, error: error instanceof Error ? error.message : String(error), pending: false });
      } finally { window.clearTimeout(timeout); controller.signal.removeEventListener('abort', cancel); pending = false; }
    };
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, 5000);
    window.addEventListener('focus', load);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', load); };
  }, [projectId, sessionId, key, refreshVersion, connectionRevision, authVersion, serverVersion]);

  const current = snapshot?.key === key ? snapshot : null;
  const status = !projectId ? 'idle' : !current || current.pending ? 'pending' : current.error ? 'error' : 'ready';
  return { resolution: status === 'ready' ? current?.value ?? null : null, error: status === 'error' ? current?.error ?? null : null, loading: status === 'pending', status, refresh };
}
