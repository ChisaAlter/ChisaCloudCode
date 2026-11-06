import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as Auth from '@/modules/auth-session';
import type * as Player from '@/modules/chat/utils/voicePlayer';
import type * as Voice from '@/modules/voice';

const transport = vi.hoisted(() => ({ synthesize: vi.fn(), signature: vi.fn() }));
vi.mock('@/shared/api', () => ({ synthesizeVoice: transport.synthesize, voiceConfigSignature: transport.signature }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function token(userId: string, signature = 'signature') {
  return `e30.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${signature}`;
}
class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  src = '';
  playResult: Promise<void> | null = null;
  play = vi.fn(() => this.playResult ?? Promise.resolve());
  pause = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => { if (name === 'src') this.src = ''; });
  constructor() { super(); FakeAudio.instances.push(this); }
}
// The singleton player is recreated with one real authority and controllable audio/response boundaries per case.
let auth: typeof Auth;
let voice: typeof Voice;
let playerModule: typeof Player;
let createUrl: ReturnType<typeof vi.fn<typeof URL.createObjectURL>>;
let revokeUrl: ReturnType<typeof vi.fn<typeof URL.revokeObjectURL>>;
async function login(user = 'alice') {
  const session = await auth.startAuthSession(token(user), auth.getAuthSessionSnapshot());
  expect(session).not.toBeNull(); auth.acknowledgeAuthSession(session!);
  return session!;
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
const audioResponse = () => ({ ok: true, blob: async () => new Blob(['speech'], { type: 'audio/mpeg' }) });

beforeEach(async () => {
  vi.resetModules();
  transport.synthesize.mockReset(); transport.signature.mockReset();
  localStorage.clear(); sessionStorage.clear();
  auth = await import('@/modules/auth-session');
  await auth.initializeAuthSession(); await login();
  voice = await import('@/modules/voice');
  transport.signature.mockImplementation(() => {
    const session = auth.getAuthSessionSnapshot();
    return JSON.stringify([session.serverKey, session.userId, session.sessionInstanceId, voice.getVoiceConfigRevision()]);
  });
  FakeAudio.instances = [];
  vi.stubGlobal('Audio', FakeAudio);
  let urlNumber = 0;
  createUrl = vi.fn<typeof URL.createObjectURL>(() => `blob:voice-test/${++urlNumber}`);
  revokeUrl = vi.fn<typeof URL.revokeObjectURL>();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
  playerModule = await import('@/modules/chat/utils/voicePlayer');
});
afterEach(async () => {
  await auth.clearAuthToken();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

test('normal TTS plays, stops, reuses cache, and survives ready token refresh', async () => {
  const { voicePlayer, voiceId } = playerModule;
  const captured = auth.getAuthSessionSnapshot();
  transport.synthesize.mockResolvedValue(audioResponse());
  const id = voiceId('hello');
  voicePlayer.toggle('hello'); await flush();
  expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'playing', error: null });
  expect(transport.synthesize.mock.calls[0][2]).toBe(captured);
  const audio = FakeAudio.instances[0];
  expect(audio.src).toBe('blob:voice-test/1');
  expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true);
  expect(voicePlayer.getSnapshot(id).state).toBe('playing');
  expect(revokeUrl).not.toHaveBeenCalled();
  voicePlayer.toggle('hello');
  expect(audio.src).toBe('');
  voicePlayer.toggle('hello'); await flush();
  expect(transport.synthesize).toHaveBeenCalledTimes(1);
  expect(voicePlayer.getSnapshot(id).state).toBe('playing');
});

test('voice cache IDs separate settings revisions and never contain the voice secret', async () => {
  const { voicePlayer, voiceId } = playerModule;
  transport.synthesize.mockResolvedValue(audioResponse());
  const first = voiceId('hello');
  voicePlayer.toggle('hello'); await flush();
  voice.writeVoiceConfig({ apiKey: 'fixture-secret', ttsVoice: 'nova' });
  const second = voiceId('hello');
  expect(second).not.toBe(first);
  expect(transport.signature()).not.toContain('fixture-secret');
  voicePlayer.toggle('hello'); await flush();
  expect(transport.synthesize).toHaveBeenCalledTimes(2);
  expect(voicePlayer.getSnapshot(second).state).toBe('playing');
});

test.each(['logout', 'server switch', 'replacement login'] as const)('%s immediately pauses, clears src, revokes every URL and clears cache', async transition => {
  const { voicePlayer, voiceId } = playerModule;
  transport.synthesize.mockResolvedValue(audioResponse());
  voicePlayer.toggle('first'); await flush();
  voicePlayer.toggle('second'); await flush();
  const oldId = voiceId('second');
  const audio = FakeAudio.instances[0]; const pauses = audio.pause.mock.calls.length;
  if (transition === 'logout') {
    const logout = auth.clearAuthToken();
    expect(audio.src).toBe('');
    await logout;
  } else if (transition === 'server switch') auth.beginAuthServerSwitch();
  else await login('bob');
  expect(audio.pause.mock.calls.length).toBeGreaterThan(pauses);
  expect(audio.src).toBe('');
  expect(revokeUrl.mock.calls.map(call => call[0]).sort()).toEqual(['blob:voice-test/1', 'blob:voice-test/2']);
  expect(voicePlayer.getSnapshot(oldId)).toEqual({ state: 'idle', error: null });
  if (transition === 'replacement login') {
    voicePlayer.toggle('first'); await flush();
    expect(transport.synthesize).toHaveBeenCalledTimes(3);
    expect(transport.synthesize.mock.calls[2][2].userId).toBe('bob');
  }
});

test('a late response after switching is discarded before blob consumption', async () => {
  const { voicePlayer, voiceId } = playerModule;
  const response = deferred<Response>();
  transport.synthesize.mockReturnValue(response.promise);
  const oldId = voiceId('old'); voicePlayer.toggle('old');
  const signal = transport.synthesize.mock.calls[0][1] as AbortSignal;
  await login('bob');
  expect(signal.aborted).toBe(true);
  const blob = vi.fn(async () => new Blob(['old']));
  response.resolve({ ok: true, blob } as unknown as Response); await flush();
  expect(blob).not.toHaveBeenCalled();
  expect(createUrl).not.toHaveBeenCalled();
  expect(voicePlayer.getSnapshot(oldId)).toEqual({ state: 'idle', error: null });
});

test.each(['resolve', 'reject'] as const)('identity change during blob parsing aborts the controller and suppresses old %s', async outcome => {
  const { voicePlayer, voiceId } = playerModule;
  const body = deferred<Blob>(); const blob = vi.fn(() => body.promise);
  transport.synthesize.mockResolvedValue({ ok: true, blob });
  const id = voiceId('old'); voicePlayer.toggle('old'); await flush();
  expect(blob).toHaveBeenCalledTimes(1);
  const signal = transport.synthesize.mock.calls[0][1] as AbortSignal;
  await login('bob');
  expect(signal.aborted).toBe(true);
  if (outcome === 'resolve') body.resolve(new Blob(['late']));
  else body.reject(new Error('old blob failed'));
  await flush();
  expect(createUrl).not.toHaveBeenCalled();
  expect(FakeAudio.instances[0].src).toBe('');
  expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'idle', error: null });
});

test('old JSON error parsing cannot publish an error to the replacement account', async () => {
  const { voicePlayer, voiceId } = playerModule;
  const body = deferred<{ error: string }>(); const json = vi.fn(() => body.promise);
  transport.synthesize.mockResolvedValue({ ok: false, status: 503, json });
  const id = voiceId('old'); voicePlayer.toggle('old'); await flush();
  expect(json).toHaveBeenCalledTimes(1);
  const signal = transport.synthesize.mock.calls[0][1] as AbortSignal;
  await auth.clearAuthToken(); expect(signal.aborted).toBe(true);
  body.resolve({ error: 'old account error' }); await flush();
  expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'idle', error: null });
});

test('pending audio.play completion cannot restore playing/error after logout', async () => {
  const { voicePlayer, voiceId } = playerModule;
  const playback = deferred<void>();
  voicePlayer.unlock();
  const audio = FakeAudio.instances[0]; audio.playResult = playback.promise;
  transport.synthesize.mockResolvedValue(audioResponse());
  const id = voiceId('hello'); voicePlayer.toggle('hello'); await flush();
  expect(audio.src).toBe('blob:voice-test/1');
  await auth.clearAuthToken();
  expect(audio.src).toBe('');
  playback.reject(new Error('late play rejection')); await flush();
  expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'idle', error: null });
});

test('identity revocation emits only the cleared error snapshot and cannot replay an old timer', async () => {
  const { voicePlayer, voiceId } = playerModule;
  vi.useFakeTimers();
  transport.synthesize.mockRejectedValue(new Error('current playback failure'));
  const id = voiceId('hello'); voicePlayer.toggle('hello'); await flush();
  expect(voicePlayer.getSnapshot(id).error).toBe('current playback failure');
  const snapshots: Array<ReturnType<typeof voicePlayer.getSnapshot>> = [];
  const unsubscribe = voicePlayer.subscribe(() => { snapshots.push(voicePlayer.getSnapshot(id)); });
  await login('bob');
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toEqual({ state: 'idle', error: null });
  await vi.advanceTimersByTimeAsync(6000);
  expect(snapshots).toHaveLength(1);
  unsubscribe();
});

test('a superseding play aborts body parsing without clobbering the new audio', async () => {
  const { voicePlayer, voiceId } = playerModule;
  const body = deferred<Blob>();
  transport.synthesize.mockResolvedValueOnce({ ok: true, blob: () => body.promise }).mockResolvedValueOnce(audioResponse());
  voicePlayer.toggle('first'); await flush();
  const oldSignal = transport.synthesize.mock.calls[0][1] as AbortSignal;
  voicePlayer.toggle('second'); await flush();
  expect(oldSignal.aborted).toBe(true);
  const secondId = voiceId('second');
  expect(voicePlayer.getSnapshot(secondId).state).toBe('playing');
  const source = FakeAudio.instances[0].src;
  body.resolve(new Blob(['old body'])); await flush();
  expect(FakeAudio.instances[0].src).toBe(source);
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(voicePlayer.getSnapshot(secondId).state).toBe('playing');
});

test('token refresh during TTS body parsing preserves loading and later playback', async () => {
  const { voicePlayer, voiceId } = playerModule;
  const captured = auth.getAuthSessionSnapshot();
  const body = deferred<Blob>();
  transport.synthesize.mockResolvedValue({ ok: true, blob: () => body.promise });
  const id = voiceId('hello'); voicePlayer.toggle('hello'); await flush();
  expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true);
  expect((transport.synthesize.mock.calls[0][1] as AbortSignal).aborted).toBe(false);
  expect(voicePlayer.getSnapshot(id).state).toBe('loading');
  body.resolve(new Blob(['same account'])); await flush();
  expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'playing', error: null });
  expect(transport.synthesize).toHaveBeenCalledTimes(1);
});

test('the client deadline also covers a stalled blob body', async () => {
  const { voicePlayer, voiceId } = playerModule;
  vi.useFakeTimers();
  const body = deferred<Blob>();
  transport.synthesize.mockResolvedValue({ ok: true, blob: () => body.promise });
  const id = voiceId('hello'); voicePlayer.toggle('hello'); await flush();
  const signal = transport.synthesize.mock.calls[0][1] as AbortSignal;
  await vi.advanceTimersByTimeAsync(330000);
  expect(signal.aborted).toBe(true);
  body.resolve(new Blob(['late'])); await flush();
  expect(createUrl).not.toHaveBeenCalled();
  expect(voicePlayer.getSnapshot(id)).toEqual({ state: 'idle', error: 'Read-aloud timed out.' });
});

test('LRU eviction and later logout revoke all generated URLs exactly once', async () => {
  const { voicePlayer } = playerModule;
  transport.synthesize.mockResolvedValue(audioResponse());
  for (let index = 0; index < 26; index++) { voicePlayer.toggle(`message ${index}`); await flush(); }
  expect(createUrl).toHaveBeenCalledTimes(26);
  expect(revokeUrl).toHaveBeenCalledTimes(2);
  await auth.clearAuthToken();
  expect(revokeUrl).toHaveBeenCalledTimes(26);
  expect(new Set(revokeUrl.mock.calls.map(call => call[0])).size).toBe(26);
});
