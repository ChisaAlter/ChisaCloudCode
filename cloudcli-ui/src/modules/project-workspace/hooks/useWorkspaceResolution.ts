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
  const [snapshot, setSnapshot] = useState<{ key: string; value: WorkspaceResolution | null; error: string | null; recoveryError?: string | null; pending: boolean } | null>(null);
  // Explicit refresh revokes old capabilities until the current identity has been checked.
  const [refreshVersion, setRefreshVersion] = useState(0);
  // Polls retry the same recovery with bounded backoff; refreshes must not create a tight recovery loop.
  const recoveryRef = useRef<{ key: string; pending: boolean; retryAt: number; failures: number; error: string | null } | null>(null);
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
        const read = async () => {
          const response = await api.workspaces.resolve(projectId, sessionId, { signal: request.signal });
          const value = await readApiJson<WorkspaceResolution>(response);
          if (!validWorkspace(value.cloudReplica, projectId, 'cloudReplica') || (value.session && !validWorkspace(value.session, projectId, 'session', sessionId))) throw new Error('工作区身份无效，请刷新重试');
          return value;
        };
        let value = await read();
        if (!current()) return;
        const local = value.cloudReplica;
        const needsRecovery = local.sourceMode === 'ssh' && (local.phase === 'recovery' || local.connectionState === 'recovery');
        let recoveryError: string | null = null;
        if (needsRecovery) {
          const recoveryKey = JSON.stringify([key, local.workspaceId, local.generation]);
          let recovery = recoveryRef.current;
          if (recovery?.key !== recoveryKey) {
            recovery = { key: recoveryKey, pending: false, retryAt: 0, failures: 0, error: null };
            recoveryRef.current = recovery;
          }
          recoveryError = recovery.error;
          if (!recovery.pending && Date.now() >= recovery.retryAt) {
            recovery.pending = true;
            try {
              // Never cancel from polling: the server verifies the exact original task or receipt.
              const result = await readApiJson<{ status: 'idle' | 'running' }>(await api.sshWorkspaces.recover({ projectId, generation: local.generation }, { signal: request.signal }));
              if (!current()) return;
              if (result.status !== 'idle' && result.status !== 'running') throw new Error('无法确认上次本地任务状态，请检查原任务后重试');
              recovery.failures = 0;
              recovery.error = recoveryError = null;
              if (result.status === 'idle') {
                const confirmed = await read();
                if (!current()) return;
                if (confirmed.cloudReplica.workspaceId !== local.workspaceId || confirmed.cloudReplica.generation !== local.generation
                  || confirmed.cloudReplica.sourceMode !== 'ssh') throw new Error('本地工作区已变化，请刷新后确认');
                value = confirmed;
              }
            } catch (failure) {
              if (!current()) return;
              ++recovery.failures;
              recovery.error = recoveryError = failure instanceof Error ? failure.message : String(failure);
            } finally {
              recovery.pending = false;
              recovery.retryAt = Date.now() + Math.min(30000, 5000 * 2 ** Math.min(recovery.failures, 3));
            }
          }
        } else recoveryRef.current = null;
        if (current()) setSnapshot({ key, value, error: null, recoveryError, pending: false });
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
  return { resolution: status === 'ready' ? current?.value ?? null : null, error: status === 'error' ? current?.error ?? null : current?.recoveryError ?? null, loading: status === 'pending', status, refresh };
}
