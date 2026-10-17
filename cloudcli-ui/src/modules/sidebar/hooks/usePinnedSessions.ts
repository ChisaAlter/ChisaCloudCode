import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';

const readPinnedSnapshot = () => {
  const preferences = readUserPreference<Record<string, unknown>>('uiPreferences', {});
  return JSON.stringify(Array.isArray(preferences.pinnedSessionIds) ? preferences.pinnedSessionIds : []);
};

/** Used by sidebar lists and row controls to persist and share conversation pins. */
export function usePinnedSessions() {
  const snapshot = useSyncExternalStore(subscribeToUserPreferences, readPinnedSnapshot);
  const pinnedSessionIds = useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot]);
  const togglePinnedSession = useCallback((sessionId: string) => {
    const preferences = readUserPreference<Record<string, unknown>>('uiPreferences', {});
    const next = new Set<string>(JSON.parse(readPinnedSnapshot()));
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    writeUserPreference('uiPreferences', { ...preferences, pinnedSessionIds: [...next] });
  }, []);
  return { pinnedSessionIds, togglePinnedSession };
}
