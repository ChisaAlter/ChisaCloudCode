import { useCallback } from 'react';

import { useWorkspaceApi } from '@/shared/context/WorkspaceScopeContext';

const readGitResponse = async (request: Promise<Response>) => (await request).json();

export function useGitActions(projectId: string | undefined) {
  const api = useWorkspaceApi();
  const fetch = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return readGitResponse(api.git.fetch(projectId));
  }, [api, projectId]);

  const pull = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return readGitResponse(api.git.pull(projectId));
  }, [api, projectId]);

  const push = useCallback(() => {
    if (!projectId) return Promise.resolve();
    return readGitResponse(api.git.push(projectId));
  }, [api, projectId]);

  const checkout = useCallback(
    (branch: string) => {
      if (!projectId) return Promise.resolve();
      return readGitResponse(api.git.checkout(projectId, branch));
    },
    [api, projectId],
  );

  return { fetch, pull, push, checkout };
}
