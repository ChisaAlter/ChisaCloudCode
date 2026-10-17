import { safeBuildIdentity } from '@/shared/utils';
import type { ChisaSyncInfo, ComponentBuildIdentity } from '@/shared/types';

/** WorkspaceSyncBar exports an allowlisted snapshot, never serializes native state or errors. */
export function createSyncDiagnostic(input: {
  status: string;
  info: ChisaSyncInfo | null;
  actionFailed: boolean;
  connectionFailed: boolean;
  versions: { client: ComponentBuildIdentity; frontend: ComponentBuildIdentity; server: ComponentBuildIdentity };
}) {
  const allowedStatuses = ['ready', 'checking', 'syncing', 'migrating', 'reserved', 'blocked', 'needs-sync', 'paused', 'disconnected', 'unavailable', 'unbound'];
  const date = input.info?.checkedAt;
  const checkedAt = date && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(date) ? date : null;
  const errors = [
    ...(input.connectionFailed ? ['state-read-failed'] : []),
    ...(input.actionFailed ? ['manual-action-incomplete'] : []),
    ...(input.status === 'blocked' ? ['sync-blocked'] : []),
    ...(input.status === 'disconnected' ? ['connection-disconnected'] : []),
  ];
  return JSON.stringify({
    product: 'ChisaCloudCode',
    collectedAt: new Date().toISOString(),
    checkedAt,
    syncStatus: allowedStatuses.includes(input.status) ? input.status : 'unknown',
    errorCategories: errors,
    components: { client: safeBuildIdentity(input.versions.client), frontend: safeBuildIdentity(input.versions.frontend), server: safeBuildIdentity(input.versions.server) },
  }, null, 2);
}
