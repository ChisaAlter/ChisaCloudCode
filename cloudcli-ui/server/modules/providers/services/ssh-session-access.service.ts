import { sessionsDb, userDb } from '@/modules/database/index.js';
import { assertCloudWorkspaceOwner } from '@/modules/workspace-runtime/index.js';
import { assertSshProjectOwner, resolveSshProjectTarget } from '@/modules/workspace-bridge/index.js';

/** Provider HTTP and chat gateways protect persisted cloud/SSH history and execution, including provider-native aliases. */
export function assertSshSessionAccess(sessionId: string, userId: string | number | null | undefined): void {
  const row = sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId);
  if (!row) return;
  const target = row.project_path ? resolveSshProjectTarget(row.project_path) : null;
  if (target) assertSshProjectOwner(target, userId);
  else assertCloudWorkspaceOwner(row.project_path, userId, userDb.getActiveUserIds());
}

/** Feed/search composition filters account-owned metadata before counts, pagination or transcript reads. */
export function canReadSshSession(sessionId: string, userId: string | number | null | undefined): boolean {
  try { assertSshSessionAccess(sessionId, userId); return true; }
  catch { return false; }
}
