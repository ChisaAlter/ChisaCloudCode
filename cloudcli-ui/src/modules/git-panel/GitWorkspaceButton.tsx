import { GitBranch } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { onWorkspaceSyncStateChanged } from '@/shared/chisa';
import type { GitStatusResponse } from '@/shared/types';
import { GIT_STATUS_OBSERVED_EVENT } from '@/shared/constants';

/** The project-workspace header uses this entry to keep source control and the current branch visible. */
export function GitWorkspaceButton({ projectId, serverPath, active, onClick }: {
  projectId?: string;
  serverPath?: string;
  active: boolean;
  onClick: () => void;
}) {
  // This small observation is scoped to the selected project, independent of whether its Git panel is open.
  const [observation, setObservation] = useState<{ projectId: string; branch: string } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let disposed = false;
    let pending = false;
    let refreshAgain = false;
    let revision = 0;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed || document.visibilityState === 'hidden') return;
      const requestedRevision = ++revision;
      if (pending) {
        refreshAgain = true;
        return;
      }
      pending = true;
      refreshAgain = false;
      try {
        const response = await api.git.status(projectId, { signal: controller.signal });
        const status = await response.json() as GitStatusResponse;
        if (!disposed && requestedRevision === revision) {
          setObservation({ projectId, branch: response.ok && !status.error ? status.branch ?? '' : '' });
        }
      } catch {
        // A failed observation must not retain a branch that may already have changed.
        if (!disposed && requestedRevision === revision) setObservation(null);
      } finally {
        pending = false;
        if (refreshAgain && !disposed) void refresh();
      }
    };
    const acceptStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; status: GitStatusResponse }>).detail;
      if (detail.projectId !== projectId) return;
      revision++;
      setObservation({ projectId, branch: detail.status.error ? '' : detail.status.branch ?? '' });
    };
    const unsubscribe = onWorkspaceSyncStateChanged(info => {
      if (info.serverPath === serverPath && info.status === 'ready') void refresh();
    });
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener(GIT_STATUS_OBSERVED_EVENT, acceptStatus);
    return () => {
      disposed = true;
      controller.abort();
      unsubscribe();
      window.removeEventListener('focus', refresh);
      window.removeEventListener(GIT_STATUS_OBSERVED_EVENT, acceptStatus);
    };
  }, [projectId, serverPath]);

  const branch = observation?.projectId === projectId ? observation?.branch : '';
  return (
    <button type="button" aria-label="Git" aria-pressed={active} onClick={onClick}
      title={branch ? `Git · ${branch}` : 'Git'} className="workspace-view-button min-w-0">
      <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span>Git</span>
      {branch && <span className="max-w-32 truncate text-xs text-muted-foreground">{branch}</span>}
    </button>
  );
}
