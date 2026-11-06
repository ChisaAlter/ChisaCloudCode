// API transport, settings and voice availability share the same account-scoped credential owner.
export { clearVoiceConfig, createVoiceCredentialStore, getVoiceConfigRevision, readVoiceConfig, subscribeToVoiceConfig,
  voiceConfigHeaders, VOICE_CONFIG_DEFAULTS, VOICE_CONFIG_STORAGE_KEY, VOICE_CONFIG_SYNC_EVENT, writeVoiceConfig } from '@/modules/voice/voiceCredentialStore';
export { useVoiceConfig } from '@/modules/voice/hooks/useVoiceConfig';
export type { VoiceConfig } from '@/shared/types';
