import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import { AppError } from '@/shared/index.js';
import type { WorkspaceDescriptor } from '@/shared/index.js';
import { requireConnectionUserId } from '@/shared/utils.js';

type ManagementScope = {
  configDir: string;
  descriptor?: WorkspaceDescriptor;
  assertCurrent(): void;
  snapshots: Map<string, { config: Record<string, unknown>; hash?: string | null }>;
};
const scopes = new AsyncLocalStorage<ManagementScope>();

/** Claude MCP/Skills adapters consume only this server-selected scope; transport payloads cannot select account-home directories. */
export function currentClaudeProjectConfigScope(): ManagementScope | undefined { return scopes.getStore(); }

/** MCP and Skills management capture the same account home as Claude runtime, authorize the saved project, and release account leases after every request. */
export async function withClaudeProjectConfigScope<T>(context: {
  userId?: unknown; workspacePath?: string; projectId?: string; workspaceId?: string; generation?: string; sessionId?: string;
  descriptor?: WorkspaceDescriptor;
}, operation: () => Promise<T>): Promise<T> {
  // Undefined is reserved for trusted legacy callers/tests. Routes always pass
  // an authenticated id or null, which fails closed before account/file lookup.
  if (context.userId === undefined) return operation();
  const userId = requireConnectionUserId(context.userId);
  const [{ projectsDb, userDb }, { assertCloudWorkspaceOwner }, { assertSshProjectOwner, assertWorkspaceDescriptor, describeWorkspaceSelection, resolveSshProjectTarget }, { resolveSelectedWorkspace }] = await Promise.all([
    import('@/modules/database/index.js'), import('@/modules/workspace-runtime/index.js'), import('@/modules/workspace-bridge/index.js'), import('@/modules/workspaces/index.js'),
  ]);
  let descriptor = context.descriptor;
  const hasSelector = Boolean(context.projectId || context.workspaceId || context.generation || context.sessionId);
  const candidate = descriptor?.sourceRoot ?? (hasSelector ? undefined : context.workspacePath);
  if (candidate) {
    const ssh = resolveSshProjectTarget(candidate);
    if (ssh) assertSshProjectOwner(ssh, userId);
    else assertCloudWorkspaceOwner(candidate, userId, userDb.getActiveUserIds());
  }
  if (!descriptor && (context.projectId || context.workspaceId || context.generation || context.sessionId)) {
    if (!context.projectId || !context.workspaceId || !context.generation) throw new AppError('A complete workspace selector is required.', { code: 'INVALID_WORKSPACE_SELECTOR', statusCode: 400 });
    descriptor = resolveSelectedWorkspace(context.projectId, { workspaceId: context.workspaceId, generation: context.generation, ...(context.sessionId ? { sessionId: context.sessionId } : {}) });
  } else if (!descriptor && context.workspacePath) {
    const project = projectsDb.getProjectPath(context.workspacePath) ?? projectsDb.getProjectPath(path.resolve(context.workspacePath));
    if (!project) throw new AppError('Project not found.', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    descriptor = describeWorkspaceSelection({ projectId: project.project_id, sourceRoot: project.project_path }).cloudReplica;
  }
  if (descriptor) {
    const ssh = resolveSshProjectTarget(descriptor.sourceRoot);
    if (ssh) assertSshProjectOwner(ssh, userId);
    else assertCloudWorkspaceOwner(descriptor.sourceRoot, userId, userDb.getActiveUserIds());
  }
  const pinned = descriptor;
  const assertCurrent = () => {
    if (!pinned) return;
    const ssh = resolveSshProjectTarget(pinned.sourceRoot);
    if (ssh) assertSshProjectOwner(ssh, userId);
    else assertCloudWorkspaceOwner(pinned.sourceRoot, userId, userDb.getActiveUserIds());
    assertWorkspaceDescriptor(pinned);
  };
  assertCurrent();
  // An active API connection owns runtime-home and must not consult an expired
  // subscription account. Account selection is captured before asynchronous IO.
  // ProviderRegistry constructs adapters at module load. Load account services
  // only at an authenticated request boundary to avoid reentering that registry.
  const [{ claudeConnectionsService }, { claudeAccountsService }, { prepareClaudeAccountHistory, prepareClaudeUserHistory }] = await Promise.all([
    import('./claude-connections.service.js'), import('./claude-accounts.service.js'), import('./claude-account-history.service.js'),
  ]);
  const api = claudeConnectionsService.getActiveConnection(userId);
  const snapshot = api ? null : claudeAccountsService.captureLaunch(userId);
  try {
    let configDir: string;
    if (snapshot) { await prepareClaudeAccountHistory(snapshot); configDir = snapshot.configDir; }
    else configDir = await prepareClaudeUserHistory(userId);
    assertCurrent();
    return await scopes.run({ configDir, descriptor: pinned, assertCurrent, snapshots: new Map() }, async () => { const result = await operation(); assertCurrent(); return result; });
  } finally { snapshot?.release(); }
}
