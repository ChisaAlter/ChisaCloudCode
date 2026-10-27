import type { Project } from '@/shared/types';

export type ProjectSelectionMetadata = Pick<
  Project,
  'projectId' | 'displayName' | 'fullPath' | 'path' | 'isStarred' | 'taskmaster' | 'sourceMode' | 'displayPath' | 'remotePath' | 'sshConnectionId' | 'connectionLabel' | 'connectionState'
>;

const valuesMatch = (left: unknown, right: unknown): boolean => (
  Object.is(left, right) || JSON.stringify(left) === JSON.stringify(right)
);

/**
 * Keep the project object consumed by the main workspace independent from the
 * sidebar's paginated session list. Session-only updates stay in `projects`;
 * this selected value changes only when workspace metadata changes.
 */
export function mergeProjectSelectionMetadata(
  current: Project,
  incoming: ProjectSelectionMetadata,
): Project {
  if (current.projectId !== incoming.projectId) {
    return current;
  }

  const nextPath = incoming.path ?? current.path;
  const nextIsStarred = incoming.isStarred ?? current.isStarred;
  const nextTaskmaster = incoming.taskmaster ?? current.taskmaster;
  const sourceMetadata = {
    sourceMode: incoming.sourceMode ?? current.sourceMode,
    displayPath: incoming.displayPath ?? current.displayPath,
    remotePath: incoming.remotePath ?? current.remotePath,
    sshConnectionId: incoming.sshConnectionId ?? current.sshConnectionId,
    connectionLabel: incoming.connectionLabel ?? current.connectionLabel,
    connectionState: incoming.connectionState ?? current.connectionState,
  };

  if (
    current.displayName === incoming.displayName
    && current.fullPath === incoming.fullPath
    && current.path === nextPath
    && current.isStarred === nextIsStarred
    && valuesMatch(current.taskmaster, nextTaskmaster)
    && Object.entries(sourceMetadata).every(([key, value]) => current[key] === value)
  ) {
    return current;
  }

  return {
    ...current,
    ...sourceMetadata,
    displayName: incoming.displayName,
    fullPath: incoming.fullPath,
    path: nextPath,
    isStarred: nextIsStarred,
    taskmaster: nextTaskmaster,
  };
}
