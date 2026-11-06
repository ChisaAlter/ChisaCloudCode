import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as Auth from '@/modules/auth-session';
import type * as Api from '@/shared/api';
import type { AuthSessionSnapshot } from '@/shared/types';
import type * as Voice from '@/shared/voiceConfig';

function token(userId: string, signature = 'signature') {
  return `e30.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${signature}`;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
// Real auth initialization, explicit login and UI acknowledgement gate every direct/proxy request in these cases.
let auth: typeof Auth;
let api: typeof Api;
let voice: typeof Voice;
let fetchMock: ReturnType<typeof vi.fn>;
async function login(user = 'alice', signature = 'signature') {
  const session = await auth.startAuthSession(token(user, signature), auth.getAuthSessionSnapshot());
  expect(session).not.toBeNull(); auth.acknowledgeAuthSession(session!);
  return session!;
}
function configure(mode: 'direct' | 'proxy', key = 'alice-voice-key') {
  voice.writeVoiceConfig({ baseUrl: mode === 'direct' ? 'https://voice.example/v1' : '', apiKey: key,
    sttModel: 'stt-fixture', ttsModel: 'tts-fixture', ttsVoice: 'nova', ttsFormat: 'wav' });
}
function request(kind: 'transcribe' | 'speech', session = auth.getAuthSessionSnapshot(), signal = new AbortController().signal) {
  return kind === 'transcribe' ? api.transcribeVoice(new Blob(['recorded audio']), 'recording.webm', signal, session)
    : api.synthesizeVoice('say hello', signal, session);
}
function controlledBody() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; }, cancel });
  return { response: new Response(stream, { headers: { 'Content-Type': 'application/json' } }), cancel,
    push(data: string) { body.enqueue(new TextEncoder().encode(data)); },
    finish(data = '{"text":"old transcript"}') { body.enqueue(new TextEncoder().encode(data)); body.close(); } };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

beforeEach(async () => {
  vi.resetModules(); vi.stubEnv('VITE_IS_PLATFORM', 'false');
  localStorage.clear(); sessionStorage.clear();
  auth = await import('@/modules/auth-session');
  expect((await auth.initializeAuthSession()).phase).toBe('signedOut');
  await login();
  voice = await import('@/shared/voiceConfig');
  api = await import('@/shared/api');
  fetchMock = vi.fn(async () => new Response('{"text":"hello"}'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

test.each(['direct', 'proxy'] as const)('%s transcription and speech keep normal configuration, payload and token ownership', async mode => {
  configure(mode);
  const session = auth.getAuthSessionSnapshot();
  expect(await (await request('transcribe')).json()).toEqual({ text: 'hello' });
  const [transcribeUrl, transcribeInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const headers = new Headers(transcribeInit.headers);
  const form = transcribeInit.body as FormData;
  expect(transcribeInit.method).toBe('POST');
  expect(form.get(mode === 'direct' ? 'file' : 'audio')).toBeInstanceOf(File);
  if (mode === 'direct') {
    expect(transcribeUrl).toBe('https://voice.example/v1/audio/transcriptions');
    expect(headers.get('Authorization')).toBe('Bearer alice-voice-key');
    expect(headers.has('x-voice-api-key')).toBe(false);
    expect(form.get('model')).toBe('stt-fixture');
    expect(transcribeInit).toMatchObject({ credentials: 'omit', redirect: 'error' });
  } else {
    expect(transcribeUrl).toBe('/api/voice/transcribe');
    expect(headers.get('Authorization')).toBe(`Bearer ${session.token}`);
    expect(headers.get('x-voice-api-key')).toBe('alice-voice-key');
    expect(headers.get('x-voice-stt-model')).toBe('stt-fixture');
  }
  expect(headers.has('Content-Type')).toBe(false);
  expect(await (await request('speech')).blob()).toBeInstanceOf(Blob);
  const [speechUrl, speechInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
  expect(speechUrl).toBe(mode === 'direct' ? 'https://voice.example/v1/audio/speech' : '/api/voice/tts');
  expect(new Headers(speechInit.headers).get('Authorization')).toBe(mode === 'direct' ? 'Bearer alice-voice-key' : `Bearer ${session.token}`);
  expect(JSON.parse(speechInit.body as string)).toEqual(mode === 'direct'
    ? { model: 'tts-fixture', voice: 'nova', input: 'say hello', response_format: 'wav' } : { text: 'say hello' });
});

test.each(['direct', 'proxy'] as const)('%s stale captured recording cannot adopt a replacement login token or voice key', async mode => {
  configure(mode);
  const captured = auth.getAuthSessionSnapshot();
  await login('bob', 'newaccount'); configure(mode, 'bob-voice-key');
  const failure = await request('transcribe', captured).then(() => null, error => error);
  expect(failure).toMatchObject({ name: 'AbortError' });
  expect(fetchMock).not.toHaveBeenCalled();
  await (await request('speech')).text();
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(new Headers(init.headers).get('Authorization')).toBe(mode === 'direct' ? 'Bearer bob-voice-key' : `Bearer ${auth.getAuthSessionSnapshot().token}`);
});

test.each(['direct', 'proxy'] as const)('%s replacement queued before dispatch prevents an old operation from reaching fetch', async mode => {
  configure(mode);
  const captured = auth.getAuthSessionSnapshot();
  const replacement = login('bob', 'replacement');
  const outcome = request('transcribe', captured).then(() => null, error => error);
  await replacement;
  configure(mode, 'bob-voice-key');
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  ['direct', 'transcribe', 'logout'], ['direct', 'speech', 'logout'],
  ['proxy', 'transcribe', 'logout'], ['proxy', 'speech', 'logout'],
  ['direct', 'transcribe', 'server switch'], ['proxy', 'speech', 'server switch'],
  ['direct', 'speech', 'replacement login'], ['proxy', 'transcribe', 'replacement login'],
] as const)('%s %s aborts on %s and rejects an ignored late transport response', async (mode, kind, transition) => {
  configure(mode);
  const captured = auth.getAuthSessionSnapshot();
  const response = deferred<Response>(); const dispatched = deferred<void>();
  fetchMock.mockImplementation((_url: string, _init: RequestInit) => { dispatched.resolve(); return response.promise; });
  const outcome = request(kind, captured).then(() => null, error => error);
  await dispatched.promise;
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  if (transition === 'logout') {
    const logout = auth.clearAuthToken();
    expect(init.signal?.aborted).toBe(true);
    await logout;
  } else if (transition === 'server switch') auth.beginAuthServerSwitch();
  else { await login('bob', 'newaccount'); configure(mode, 'bob-voice-key'); }
  expect(init.signal?.aborted).toBe(true);
  response.resolve(new Response('{"text":"late transcript"}'));
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const headers = new Headers(init.headers);
  expect(headers.get('Authorization')).toBe(mode === 'direct' ? 'Bearer alice-voice-key' : `Bearer ${captured.token}`);
  expect([...headers.values()].join()).not.toContain('bob-voice-key');
  expect([...headers.values()].join()).not.toContain('newaccount');
});

test.each(['direct', 'proxy'] as const)('%s body wrapper rejects late JSON after identity replacement and cancels the old source', async mode => {
  configure(mode);
  const body = controlledBody(); fetchMock.mockResolvedValue(body.response);
  const response = await request('transcribe');
  const outcome = response.json().then(() => null, error => error);
  await flush();
  const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal;
  await login('bob');
  expect(signal?.aborted).toBe(true);
  body.push('{"text":"old transcript"}');
  expect(await outcome).toMatchObject({ name: 'AbortError' });
  expect(body.cancel).toHaveBeenCalledTimes(1);
  expect(auth.getAuthSessionSnapshot().userId).toBe('bob');
});

test.each(['direct', 'proxy'] as const)('%s body wrapper rejects late TTS blobs after a server switch', async mode => {
  configure(mode);
  const body = controlledBody(); fetchMock.mockResolvedValue(body.response);
  const response = await request('speech');
  const outcome = response.blob().then(() => null, error => error);
  await flush();
  auth.beginAuthServerSwitch();
  expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  body.finish('old audio bytes');
  expect(await outcome).toMatchObject({ name: 'AbortError' });
});

test.each(['direct', 'proxy'] as const)('%s token refresh preserves the captured request and streamed body within one ready incarnation', async mode => {
  configure(mode);
  const captured = auth.getAuthSessionSnapshot();
  const body = controlledBody(); fetchMock.mockResolvedValue(body.response);
  const response = await request('transcribe', captured);
  const data = response.json();
  expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true);
  expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(false);
  body.finish('{"text":"same account"}');
  expect(await data).toEqual({ text: 'same account' });
  expect(auth.getAuthSessionSnapshot()).toMatchObject({ sessionInstanceId: captured.sessionInstanceId, phase: 'ready', tokenRevision: 1 });
});

test.each(['direct', 'proxy'] as const)('%s caller AbortSignal is forwarded to request and body parsing', async mode => {
  configure(mode);
  const caller = new AbortController(); const body = controlledBody(); fetchMock.mockResolvedValue(body.response);
  const response = await request('transcribe', auth.getAuthSessionSnapshot(), caller.signal);
  const outcome = response.json().then(() => null, error => error);
  caller.abort(new DOMException('Canceled by composer', 'AbortError'));
  expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  body.finish();
  expect(await outcome).toMatchObject({ name: 'AbortError' });
});

test.each(['direct', 'proxy'] as const)('%s explicit response cancellation releases the underlying source', async mode => {
  configure(mode);
  const body = controlledBody(); fetchMock.mockResolvedValue(body.response);
  const response = await request('speech');
  const reason = new DOMException('Playback stopped', 'AbortError');
  await response.body!.cancel(reason);
  expect(body.cancel).toHaveBeenCalledExactlyOnceWith(reason);
});

test('voice signature contains identity and revision while never serializing config secrets', async () => {
  configure('direct');
  const captured = auth.getAuthSessionSnapshot();
  const initial = api.voiceConfigSignature();
  expect(JSON.parse(initial)).toEqual([captured.serverKey, captured.userId, captured.sessionInstanceId, voice.getVoiceConfigRevision()]);
  expect(initial).not.toContain('alice-voice-key');
  expect(initial).not.toContain('https://voice.example');
  expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true);
  expect(api.voiceConfigSignature()).toBe(initial);
  voice.writeVoiceConfig({ apiKey: 'replacement-secret' });
  expect(api.voiceConfigSignature()).not.toBe(initial);
  expect(api.voiceConfigSignature()).not.toContain('replacement-secret');
});

test('signed-out or unacknowledged ready accounts cannot issue a voice request', async () => {
  const ready = auth.getAuthSessionSnapshot();
  await auth.clearAuthToken();
  expect(await request('speech').then(() => null, error => error)).toMatchObject({ name: 'AbortError' });
  const unacknowledged: AuthSessionSnapshot | null = await auth.startAuthSession(token('bob'), auth.getAuthSessionSnapshot());
  expect(unacknowledged?.phase).toBe('ready');
  expect(await request('speech').then(() => null, error => error)).toMatchObject({ name: 'AbortError' });
  expect(await request('speech', ready).then(() => null, error => error)).toMatchObject({ name: 'AbortError' });
  expect(fetchMock).not.toHaveBeenCalled();
});
