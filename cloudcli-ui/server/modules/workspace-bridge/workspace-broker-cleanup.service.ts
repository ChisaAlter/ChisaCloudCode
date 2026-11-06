import { getWorkspaceBrokerAdmission } from '@/modules/workspace-runtime/index.js';
import { AppError } from '@/shared/index.js';

/** Preview callbacks only notify. The bridge authenticates the broker and checks
 * its exact immutable operation receipt before removing the legacy reservation. */
export async function confirmWorkspaceBrokerCleanup(input: { userId: string; root: string; leaseId: string; brokerLeaseId?: string; bindingEpoch: string; sessionId?: string; profileId: string; operationId: string }) {
  const admission = await getWorkspaceBrokerAdmission(input);
  if (admission.legacyReservationId !== input.leaseId || (input.brokerLeaseId !== undefined && admission.leaseId !== input.brokerLeaseId) || !input.profileId || admission.previewProfileId !== input.profileId) {
    throw new AppError('Preview broker reservation changed', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  }
  const receipt = await admission.client.reconcile(await admission.proof('reconcile',input.profileId),input.operationId);
  if (receipt.operationId !== input.operationId || receipt.workspaceId !== admission.workspaceId || receipt.generation !== admission.generation || receipt.leaseId !== admission.leaseId || receipt.profileId !== input.profileId ||
    receipt.kind !== 'run' || receipt.state !== 'complete' || receipt.cleanupConfirmed !== true || !receipt.resourceId || !/^[a-f0-9]{64}$/.test(receipt.resourceId)) {
    throw new AppError('Exact preview broker cleanup is still pending', { code: 'WORKSPACE_CLEANUP_FAILED', statusCode: 503 });
  }
}
