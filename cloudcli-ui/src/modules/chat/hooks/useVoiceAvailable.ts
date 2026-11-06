import { useEffect, useState, useSyncExternalStore } from 'react';

import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';
import { getVoiceConfigRevision, readVoiceConfig, subscribeToVoiceConfig } from '@/modules/voice';
import { api } from '@/shared/api';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { AuthSessionSnapshot } from '@/shared/types';

// A shared health check may be reused only by the same account incarnation and voice configuration.
const healthRequests = new Map<string, Promise<boolean>>();
function healthKey(session: AuthSessionSnapshot, revision: number): string {
  return JSON.stringify([session.serverKey, session.userId, session.sessionInstanceId, revision]);
}
function checkVoiceHealth(expected: AuthSessionSnapshot, revision: number): Promise<boolean> {
  const key = healthKey(expected, revision);
  const pending = healthRequests.get(key);
  if (pending) return pending;
  const controller = new AbortController();
  const valid = () => !controller.signal.aborted && isCurrentAuthSession(expected)
    && getAuthSessionSnapshot().phase === 'ready' && getVoiceConfigRevision() === revision;
  const abortStale = () => { if (!valid()) controller.abort(); };
  const unsubscribeAuth = subscribeToAuthSession(abortStale);
  const unsubscribeConfig = subscribeToVoiceConfig(abortStale);
  const request = api.voice.health({ expectedSession: expected, signal: controller.signal })
    .then(async response => {
      if (!valid()) return false;
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      return valid() && data?.configured === true;
    })
    .finally(() => {
      unsubscribeAuth();
      unsubscribeConfig();
      if (healthRequests.get(key) === request) healthRequests.delete(key);
    });
  healthRequests.set(key, request);
  return request;
}

/** Chat controls display voice availability for the verified current account only. */
export function useVoiceAvailable(): boolean {
  const { voiceEnabled: enabled } = useUiPreferences();
  const session = useSyncExternalStore(subscribeToAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  const revision = useSyncExternalStore(subscribeToVoiceConfig, getVoiceConfigRevision, getVoiceConfigRevision);
  // Availability carries its origin so a replacement login cannot briefly display the old account's health.
  const [result, setResult] = useState<{ key: string; available: boolean } | null>(null);
  const key = healthKey(session, revision);
  useEffect(() => {
    let active = true;
    // Capture only when the account/configuration key changes; token refresh preserves this work.
    const expected = getAuthSessionSnapshot();
    const capturedRevision = getVoiceConfigRevision();
    if (!enabled || expected.phase !== 'ready' || healthKey(expected, capturedRevision) !== key) return;
    const apply = (available: boolean) => {
      if (active && isCurrentAuthSession(expected) && getVoiceConfigRevision() === capturedRevision)
        setResult({ key, available });
    };
    if (readVoiceConfig(expected).baseUrl.trim()) apply(true);
    else void checkVoiceHealth(expected, capturedRevision).then(apply, () => apply(false));
    return () => { active = false; };
  }, [enabled, key, session.phase]);
  return enabled && session.phase === 'ready' && result?.key === key && result.available;
}
