import { useWorkspaceApi, useWorkspaceScope } from '@/shared/context/WorkspaceScopeContext';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';

export type BranchResult = { name: string };

type BranchesResponse = {
  localBranches?: string[];
};

export function useBranchesSource(projectId: string | undefined, enabled: boolean) {
  const api = useWorkspaceApi();
  const workspace = useWorkspaceScope();
  return useApiSource<BranchResult, BranchesResponse>({
    enabled: enabled && !!projectId && workspace !== null && workspace?.capabilities.git !== false,
    deps: [projectId, api],
    fetcher: (signal) => api.git.branches(projectId!, { signal }),
    parse: (data) => (data.localBranches ?? []).map((name) => ({ name })),
  });
}
