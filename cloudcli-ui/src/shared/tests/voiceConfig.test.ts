import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import type * as Auth from '@/modules/auth-session';
import type * as VoiceConfig from '@/shared/voiceConfig';

/** Header validation runs against the verified account partition rather than the unowned legacy global key. */
// Each case loads a fresh authority and credential cache before committing and acknowledging its login.
let auth: typeof Auth;
let voice: typeof VoiceConfig;
function token(userId: string) {
  return `e30.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
}
async function login(userId = 'alice') {
  const session = await auth.startAuthSession(token(userId), auth.getAuthSessionSnapshot());
  assert.ok(session);
  auth.acknowledgeAuthSession(session);
  return session;
}
function scopedKey() {
  const session = auth.getAuthSessionSnapshot();
  return `chisa-voice:v2:${encodeURIComponent(session.serverKey)}:${encodeURIComponent(session.userId!)}`;
}
function writeRaw(value: string) {
  localStorage.setItem(scopedKey(), value);
  // Real external storage updates invalidate the owner cache through this notification.
  window.dispatchEvent(new StorageEvent('storage', { key: scopedKey() }));
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear(); sessionStorage.clear();
  auth = await import('@/modules/auth-session');
  assert.equal((await auth.initializeAuthSession()).phase, 'signedOut');
  await login();
  voice = await import('@/shared/voiceConfig');
});
afterEach(() => { vi.restoreAllMocks(); });

test('no stored config sends no headers at all', () => {
  assert.deepEqual(voice.voiceConfigHeaders(), {});
});

test('unknown legacy global credentials are ignored even for an acknowledged account', () => {
  localStorage.setItem(voice.VOICE_CONFIG_STORAGE_KEY, JSON.stringify({ apiKey: 'unowned-key', baseUrl: 'https://unknown.test', sttModel: 'unowned-model' }));
  localStorage.setItem('globalapikey', 'unknown-global');
  assert.deepEqual(voice.readVoiceConfig(), voice.VOICE_CONFIG_DEFAULTS);
  assert.deepEqual(voice.voiceConfigHeaders(), {});
});

test('an empty api key is omitted, not sent blank', () => {
  voice.writeVoiceConfig({ apiKey: '', sttModel: 'whisper-1' });
  const headers = voice.voiceConfigHeaders();
  assert.equal('x-voice-api-key' in headers, false);
  assert.equal(headers['x-voice-stt-model'], 'whisper-1');
});

test('each configured field maps to its own header within the account partition', () => {
  voice.writeVoiceConfig({ apiKey: 'fixture-key', sttModel: 'whisper-1', ttsModel: 'tts-1', ttsVoice: 'alloy', ttsFormat: 'mp3' });
  assert.deepEqual(voice.voiceConfigHeaders(), {
    'x-voice-api-key': 'fixture-key', 'x-voice-stt-model': 'whisper-1', 'x-voice-tts-model': 'tts-1',
    'x-voice-tts-voice': 'alloy', 'x-voice-tts-format': 'mp3',
  });
  assert.equal(localStorage.getItem(voice.VOICE_CONFIG_STORAGE_KEY), null);
  assert.ok(localStorage.getItem(scopedKey()));
});

test('baseUrl is never sent as a proxy header', () => {
  voice.writeVoiceConfig({ baseUrl: 'https://example.test', apiKey: 'fixture-key' });
  assert.deepEqual(Object.keys(voice.voiceConfigHeaders()), ['x-voice-api-key']);
});

test('a whitespace-only tts format is treated as unset', () => {
  voice.writeVoiceConfig({ ttsFormat: '   ' });
  assert.deepEqual(voice.voiceConfigHeaders(), {});
});

test('a padded tts format is trimmed before being sent', () => {
  voice.writeVoiceConfig({ ttsFormat: '  mp3  ' });
  assert.equal(voice.voiceConfigHeaders()['x-voice-tts-format'], 'mp3');
});

test('a non-string field is discarded rather than coerced into a header', () => {
  writeRaw(JSON.stringify({ apiKey: 12345, sttModel: 'whisper-1' }));
  assert.deepEqual(voice.voiceConfigHeaders(), { 'x-voice-stt-model': 'whisper-1' });
});

test('unparsable scoped storage falls back to defaults instead of throwing', () => {
  writeRaw('{not json');
  assert.deepEqual(voice.readVoiceConfig(), voice.VOICE_CONFIG_DEFAULTS);
  assert.deepEqual(voice.voiceConfigHeaders(), {});
});

test('a scoped stored array is not treated as a config object', () => {
  writeRaw('["apiKey"]');
  assert.deepEqual(voice.readVoiceConfig(), voice.VOICE_CONFIG_DEFAULTS);
});

test('each read returns its own object so a caller cannot mutate the defaults', () => {
  const first = voice.readVoiceConfig(); first.apiKey = 'mutated';
  assert.equal(voice.readVoiceConfig().apiKey, '');
  assert.equal(voice.VOICE_CONFIG_DEFAULTS.apiKey, '');
});

test('replacement login cannot read the old account partition or use its stale capture', async () => {
  const first = auth.getAuthSessionSnapshot();
  voice.writeVoiceConfig({ apiKey: 'alice-voice-key', sttModel: 'alice-model' });
  await login('bob');
  assert.deepEqual(voice.readVoiceConfig(), voice.VOICE_CONFIG_DEFAULTS);
  assert.deepEqual(voice.voiceConfigHeaders(first), {});
  voice.writeVoiceConfig({ apiKey: 'bob-voice-key', sttModel: 'bob-model' });
  assert.equal(voice.voiceConfigHeaders()['x-voice-api-key'], 'bob-voice-key');
  assert.throws(() => voice.writeVoiceConfig({ apiKey: 'late-write' }, first), { name: 'AbortError' });
  await login('alice');
  assert.equal(voice.readVoiceConfig().apiKey, '');
  assert.equal(voice.readVoiceConfig().sttModel, 'alice-model');
});
