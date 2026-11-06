/** Compatibility export for API and existing voice consumers; the voice module owns per-account credentials and change notifications. */
export { clearVoiceConfig, getVoiceConfigRevision, readVoiceConfig, subscribeToVoiceConfig, voiceConfigHeaders,
  VOICE_CONFIG_DEFAULTS, VOICE_CONFIG_STORAGE_KEY, VOICE_CONFIG_SYNC_EVENT, writeVoiceConfig } from '@/modules/voice';
export type { VoiceConfig } from '@/shared/types';
