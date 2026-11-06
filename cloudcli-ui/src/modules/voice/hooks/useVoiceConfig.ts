import { useSyncExternalStore } from 'react';

import { getAuthSessionSnapshot } from '@/modules/auth-session';
import { getVoiceConfigRevision, readVoiceConfig, subscribeToVoiceConfig, writeVoiceConfig } from '@/modules/voice/voiceCredentialStore';
import type { VoiceConfig } from '@/shared/types';

/** Settings owns the form but voice owns its account partition and stale callback fence. */
export function useVoiceConfig() {
  useSyncExternalStore(subscribeToVoiceConfig, getVoiceConfigRevision, getVoiceConfigRevision);
  const captured = getAuthSessionSnapshot();
  return { config: readVoiceConfig(captured), update: (patch: Partial<VoiceConfig>) => writeVoiceConfig(patch, captured) };
}
