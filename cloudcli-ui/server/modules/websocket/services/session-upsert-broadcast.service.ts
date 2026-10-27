import path from 'node:path';

import { projectsDb, sessionsDb, sshProjectTargetsDb } from '@/modules/database/index.js';
import { generateDisplayName } from '@/modules/projects/index.js';
import { canReadSshSession } from '@/modules/providers/index.js';
import { connectedClients, getConnectedClientUserId, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { SessionUpsertedEvent } from '@/shared/types.js';

/**
 * The single producer of the `session_upserted` delta.
 *
 * The event carries everything a sidebar needs to upsert a session in place
 * (its summary plus the owning project's metadata), so clients never refetch
 * the whole project list because one transcript changed on disk.
 *
 * It used to be built in two places — the on-disk sessions watcher and the
 * chat run registry — and only the registry's copy set `providerSessionId`.
 * That field is how the client notices a row it is showing has been merged
 * into its canonical app-session row, so a merge announced by any other path
 * left a stale duplicate in the sidebar. One builder, one shape.
 */
async function buildSessionUpsertedEvent(
  sessionIdOrProviderSessionId: string,
): Promise<SessionUpsertedEvent | null> {
  // Resolving by provider id first covers the watcher, which only ever sees
  // the id written in the transcript. For a row where the two ids are equal
  // — legacy rows, and any session indexed from disk before its mapping
  // existed — both lookups land on the same row anyway.
  const row = sessionsDb.getSessionByProviderSessionId(sessionIdOrProviderSessionId)
    ?? sessionsDb.getSessionById(sessionIdOrProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const ssh = project ? sshProjectTargetsDb.getByProjectId(project.project_id) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : ssh ? path.win32.basename(ssh.rootPath) || ssh.rootPath
      : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return {
    kind: 'session_upserted',
    sessionId: row.session_id,
    providerSessionId: row.provider_session_id ?? null,
    // The column is a plain TEXT and typed as `string` on the row, but only
    // provider adapters ever write it.
    provider: row.provider as SessionUpsertedEvent['provider'],
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
        ...(ssh ? { sourceMode: 'ssh' as const, displayPath: ssh.rootPath, remotePath: ssh.rootPath,
          connectionLabel: ssh.connectionLabel, sshConnectionId: ssh.connectionId } : {}),
      }
      : null,
    timestamp: new Date().toISOString(),
  };
}

function sendToConnectedClients(events: SessionUpsertedEvent[]): void {
  const payloads = events.flatMap(event => {
    const target = event.project ? sshProjectTargetsDb.getByProjectId(event.project.projectId) : null;
    // A deleted SSH binding must never turn an already-built local event into a public cloud event.
    if (event.project?.sourceMode === 'ssh' && !target) return [];
    return [{ payload: JSON.stringify(event), ownerId: target?.ownerId, sessionId: event.sessionId }];
  });
  connectedClients.forEach((client) => {
    if (client.readyState !== WS_OPEN_STATE) return;
    const userId = getConnectedClientUserId(client);
    for (const item of payloads) {
      if ((item.ownerId === undefined || item.ownerId === userId) && canReadSshSession(item.sessionId, userId)) client.send(item.payload);
    }
  });
}

/** Announces one session. Used by the chat run registry when a run reports its provider-native id. */
export async function broadcastSessionUpserted(sessionIdOrProviderSessionId: string): Promise<void> {
  const event = await buildSessionUpsertedEvent(sessionIdOrProviderSessionId);
  if (event) {
    sendToConnectedClients([event]);
  }
}

/**
 * Announces a batch of sessions. Used by the providers module's sessions
 * watcher, whose debounced flush can carry dozens of ids at once — the client
 * set is walked once for the whole batch rather than once per session.
 */
export async function broadcastSessionUpsertedBatch(
  sessionIds: Iterable<string>,
): Promise<void> {
  const events: SessionUpsertedEvent[] = [];
  for (const sessionId of sessionIds) {
    const event = await buildSessionUpsertedEvent(sessionId);
    if (event) events.push(event);
  }

  sendToConnectedClients(events);
}

/** @internal Exported for the broadcast tests, which assert the payload shape directly. */
export { buildSessionUpsertedEvent };
