import { sshProjectTargetsDb } from '@/modules/database/index.js';
import { broadcastToUser } from '@/modules/websocket/index.js';

import { agentRelayBroker } from './agent-relay.service.js';
import type { AgentWorkspaceFileEvent } from './agent-relay.service.js';
import { sshWorkspaceReadCache } from './workspace-read-cache.service.js';

const MAX_BROADCAST_PATHS = 64;

let started = false;

function projectForEvent(ownerId: string, event: AgentWorkspaceFileEvent): string | null {
  if (!event.rootIdentity) return null;
  try {
    return sshProjectTargetsDb.findByOwnerRootIdentity(ownerId, event.rootIdentity)?.projectId ?? null;
  } catch {
    // A missing/unmigrated database keeps the advisory broadcast generic.
    return null;
  }
}

/**
 * Relay-delivered filesystem observations reach two consumers here: the read
 * cache drops the affected root bucket, and the owner's open sockets get one
 * debounce-friendly workspace-changed frame per reported root. Registration is
 * idempotent because routers and tests may initialize more than once.
 */
export function ensureAgentWorkspaceEventFanout() {
  if (started) return;
  started = true;
  agentRelayBroker.onWorkspaceEvents(({ ownerId, connectionId, events }) => {
    const byRoot = new Map<string, { projectId: string | null | undefined; paths: Set<string> }>();
    for (const event of events) {
      sshWorkspaceReadCache.invalidateRoot(ownerId, connectionId, event.rootIdentity ?? event.root);
      const bucket = byRoot.get(event.root) ?? { projectId: undefined, paths: new Set<string>() };
      bucket.projectId ??= projectForEvent(ownerId, event);
      if (bucket.paths.size < MAX_BROADCAST_PATHS) bucket.paths.add(event.path);
      byRoot.set(event.root, bucket);
    }
    for (const [root, bucket] of byRoot) {
      broadcastToUser(ownerId, JSON.stringify({
        kind: 'ssh_workspace_changed',
        connectionId,
        rootPath: root,
        projectId: bucket.projectId ?? null,
        paths: [...bucket.paths],
        at: Date.now(),
      }));
    }
  });
}
