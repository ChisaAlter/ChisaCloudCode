import { createHash } from 'node:crypto';
import path from 'node:path';

import { AppError } from '@/shared/index.js';

import { getWorkspaceBrokerAdmission } from './workspace-runtime-broker.service.js';

/** Runtime restore retires only the independently enrolled exact legacy transport.
 * Broker pins its immutable id/mounts/network; API has no Docker CLI fallback. */
export async function retireWorkspaceSyncTransport(root: string, owner: string, userId?: string): Promise<void> {
  if (!userId || owner !== createHash('sha256').update(path.resolve(root) + '\0' + userId).digest('hex').slice(0,24)) {
    throw new AppError('Legacy transport authority is unavailable', { code: 'WORKSPACE_RUNTIME_MISMATCH', statusCode: 503 });
  }
  const admission = await getWorkspaceBrokerAdmission({ userId,root });
  await admission.retireLegacy();
}
