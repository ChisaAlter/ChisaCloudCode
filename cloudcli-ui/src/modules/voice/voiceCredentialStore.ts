import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';
import type { AuthSessionSnapshot, VoiceConfig } from '@/shared/types';

const STORAGE_PREFIX = 'chisa-voice:v2:';
const SYNC_EVENT = 'voice-config:sync';
const DEFAULTS: VoiceConfig = { baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' };

/** Settings, API transport and voice hooks share this immutable blank configuration; no legacy global credential is inferred. */
export const VOICE_CONFIG_DEFAULTS = Object.freeze(DEFAULTS);
/** Existing availability listeners are awakened without putting credentials into an event payload. */
export const VOICE_CONFIG_SYNC_EVENT = SYNC_EVENT;
/** Compatibility-only legacy key: scoped readers intentionally never consume this record. */
export const VOICE_CONFIG_STORAGE_KEY = 'voiceConfig';

function storageKey(session: AuthSessionSnapshot): string | null {
  return session.phase === 'ready' && session.userId && session.serverKey
    ? `${STORAGE_PREFIX}${encodeURIComponent(session.serverKey)}:${encodeURIComponent(session.userId)}` : null;
}
function safeConfig(value: unknown): VoiceConfig {
  const next = { ...DEFAULTS };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return next;
  for (const key of Object.keys(DEFAULTS) as (keyof VoiceConfig)[]) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === 'string' && field.length <= 8192 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(field)) next[key] = field;
  }
  return next;
}

/** Voice settings and tests instantiate this store; all secret reads/writes require the captured account incarnation to remain current. */
export function createVoiceCredentialStore(host: {
  storage: Storage;
  getSession(): AuthSessionSnapshot;
  isCurrent(session: AuthSessionSnapshot): boolean;
  subscribe(listener: () => void): () => void;
  notify?(): void;
}) {
  const listeners = new Set<() => void>();
  const revokedSecrets = new Set<string>();
  let observed = host.getSession();
  let cachedKey: string | null = null;
  let cached: VoiceConfig = { ...DEFAULTS };
  let revision = 0;
  function notify() { revision++; for (const listener of listeners) listener(); host.notify?.(); }
  function eraseSecret(session: AuthSessionSnapshot) {
    const key = storageKey({ ...session, phase: 'ready' });
    if (!key) return;
    revokedSecrets.add(key);
    try {
      const prior = safeConfig(JSON.parse(host.storage.getItem(key) ?? 'null'));
      host.storage.setItem(key, JSON.stringify({ ...prior, apiKey: '' }));
    } catch { /* A denied storage write never exposes an old in-memory credential. */ }
  }
  const unsubscribe = host.subscribe(() => {
    const next = host.getSession();
    if (next.sessionInstanceId !== observed.sessionInstanceId || next.serverKey !== observed.serverKey
      || next.userId !== observed.userId || next.phase !== observed.phase) {
      // Entering switching/closing revokes cached keys before any await. Persisted secrets are not inherited on return.
      eraseSecret(observed);
      cachedKey = null;
      cached = { ...DEFAULTS };
      observed = next;
      notify();
    }
  });
  function read(session = host.getSession()): VoiceConfig {
    const key = storageKey(session);
    if (!key || !host.isCurrent(session)) return { ...DEFAULTS };
    try {
      if (key !== cachedKey) {
        cached = safeConfig(JSON.parse(host.storage.getItem(key) ?? 'null'));
        cachedKey = key;
      }
      return { ...cached, ...(revokedSecrets.has(key) ? { apiKey: '' } : {}) };
    } catch { return { ...DEFAULTS }; }
  }
  function write(patch: Partial<VoiceConfig>, session = host.getSession()): VoiceConfig {
    const key = storageKey(session);
    if (!key || !host.isCurrent(session)) throw new DOMException('Voice account session changed', 'AbortError');
    const next = safeConfig({ ...read(session), ...patch });
    host.storage.setItem(key, JSON.stringify(next));
    if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) revokedSecrets.delete(key);
    cachedKey = key;
    cached = next;
    notify();
    return { ...next };
  }
  return { read, write, clear(session = host.getSession()) { write({ ...DEFAULTS }, session); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getRevision: () => revision,
    invalidate() { cachedKey = null; cached = { ...DEFAULTS }; notify(); },
    dispose() { unsubscribe(); cached = { ...DEFAULTS }; cachedKey = null; listeners.clear(); } };
}
const browserStorage: Storage = {
  get length() { try { return globalThis.localStorage?.length ?? 0; } catch { return 0; } },
  clear() { globalThis.localStorage.clear(); },
  key(index) { try { return globalThis.localStorage?.key(index) ?? null; } catch { return null; } },
  getItem(key) { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
  setItem(key, value) { globalThis.localStorage.setItem(key, value); },
  removeItem(key) { globalThis.localStorage.removeItem(key); },
};
const store = createVoiceCredentialStore({ storage: browserStorage, getSession: getAuthSessionSnapshot,
  isCurrent: isCurrentAuthSession, subscribe: subscribeToAuthSession,
  notify: () => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(SYNC_EVENT)); } });
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) store.invalidate();
});
/** API and settings read only the current server/account partition; a stale caller receives no credential. */
export const readVoiceConfig = store.read;
/** Settings uses conditional writes so an old input callback cannot edit the next account's credentials. */
export const writeVoiceConfig = store.write;
/** Voice settings provides explicit removal of the current account's configuration. */
export const clearVoiceConfig = store.clear;
/** Settings subscribes to account changes and same-tab configuration edits without retaining a secret state mirror. */
export const subscribeToVoiceConfig = store.subscribe;
/** The settings hook uses a primitive external-store version rather than a mutable config reference. */
export const getVoiceConfigRevision = store.getRevision;
/** Voice proxy headers are bound to the same captured account as request admission. */
export function voiceConfigHeaders(session = getAuthSessionSnapshot()): Record<string, string> {
  const config = readVoiceConfig(session);
  const headers: Record<string, string> = {};
  if (config.apiKey) headers['x-voice-api-key'] = config.apiKey;
  if (config.sttModel) headers['x-voice-stt-model'] = config.sttModel;
  if (config.ttsModel) headers['x-voice-tts-model'] = config.ttsModel;
  if (config.ttsVoice) headers['x-voice-tts-voice'] = config.ttsVoice;
  if (config.ttsFormat.trim()) headers['x-voice-tts-format'] = config.ttsFormat.trim();
  return headers;
}
