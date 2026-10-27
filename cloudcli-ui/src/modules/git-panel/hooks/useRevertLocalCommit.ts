import { useCallback, useEffect, useRef, useState } from 'react';

import { useWorkspaceApi } from '@/shared/context/WorkspaceScopeContext';

type UseRevertLocalCommitOptions = {
  // DB primary key for the project; forwarded to the git API via the
  // `project` body param.
  projectId: string | null;
  onSuccess?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export function useRevertLocalCommit({ projectId, onSuccess, onError }: UseRevertLocalCommitOptions) {
  const api = useWorkspaceApi();
  // Project-scoped ownership keeps pending feedback visible through the write and its refresh.
  const [pendingOperation, setPendingOperation] = useState<{ projectId: string | null; operation: symbol | null }>({ projectId, operation: null });
  const projectEpochRef = useRef(0);
  const pendingRef = useRef<symbol | null>(null);
  if (pendingOperation.projectId !== projectId) {
    setPendingOperation({ projectId, operation: null });
  }
  const isRevertingLocalCommit = pendingOperation.projectId === projectId && pendingOperation.operation !== null;

  useEffect(() => {
    const epoch = ++projectEpochRef.current;
    pendingRef.current = null;
    return () => {
      projectEpochRef.current = epoch + 1;
      pendingRef.current = null;
    };
  }, [api, projectId]);

  const revertLatestLocalCommit = useCallback(async () => {
    if (!projectId || pendingRef.current) return;
    const epoch = projectEpochRef.current;
    const operation = Symbol('revert');
    pendingRef.current = operation;
    const isCurrent = () => epoch === projectEpochRef.current && pendingRef.current === operation;
    setPendingOperation({ projectId, operation });
    onError?.(null);
    try {
      const response = await api.git.revertLocalCommit(projectId);
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new Error(response.ok
          ? 'Git returned an invalid response. Please try again.'
          : `Revert local commit failed (HTTP ${response.status})`);
      }
      if (!isCurrent()) return;
      const data = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown> : null;
      if (!response.ok || data?.success !== true || data.error) {
        // The controller normalizes unknown backend payloads before rendering them.
        throw data?.error ?? new Error(response.ok
          ? 'Revert local commit failed'
          : `Revert local commit failed (HTTP ${response.status})`);
      }
      await onSuccess?.();
    } catch (error) {
      if (!isCurrent()) return;
      onError?.(error);
      // Keep the confirmation open so the user can retry the failed operation.
      throw error;
    } finally {
      if (isCurrent()) {
        pendingRef.current = null;
        setPendingOperation({ projectId, operation: null });
      }
    }
  }, [api, onError, onSuccess, projectId]);

  return { isRevertingLocalCommit, revertLatestLocalCommit };
}
