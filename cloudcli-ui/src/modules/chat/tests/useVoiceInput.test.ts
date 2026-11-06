import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as Auth from '@/modules/auth-session';
import type * as VoiceInput from '@/modules/chat/hooks/useVoiceInput';

const transport = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('@/shared/api', () => ({ transcribeVoice: transport.transcribe }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function token(userId: string, signature = 'signature') {
  return `e30.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${signature}`;
}
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = () => true;
  state = 'inactive';
  mimeType = 'audio/webm';
  onstop: (() => Promise<void> | void) | null = null;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor() { FakeRecorder.instances.push(this); }
  start() { this.state = 'recording'; }
  stop = vi.fn(() => { this.state = 'inactive'; });
  finish(size = 1000) {
    this.ondataavailable?.({ data: new Blob(['a'.repeat(size)]) });
    return this.onstop?.();
  }
}
// Each case owns its real authority, microphone permission gate and deferred recorder stop event.
let auth: typeof Auth;
let useVoiceInput: typeof VoiceInput.useVoiceInput;
let permission: ReturnType<typeof deferred<MediaStream>>;
let trackStop: ReturnType<typeof vi.fn>;
let stream: MediaStream;

async function login(user = 'alice', signature = 'signature') {
  const session = await auth.startAuthSession(token(user, signature), auth.getAuthSessionSnapshot());
  expect(session).not.toBeNull();
  auth.acknowledgeAuthSession(session!);
  return session!;
}
function renderVoice() {
  const transcript = vi.fn();
  const error = vi.fn();
  const hook = renderHook(() => useVoiceInput(transcript, error));
  return { ...hook, transcript, error };
}
async function record(hook: ReturnType<typeof renderVoice>) {
  await act(async () => { hook.result.current.toggle(); permission.resolve(stream); });
  expect(hook.result.current.state).toBe('recording');
  return FakeRecorder.instances[0];
}

beforeEach(async () => {
  vi.resetModules();
  transport.transcribe.mockReset();
  localStorage.clear(); sessionStorage.clear();
  auth = await import('@/modules/auth-session');
  expect((await auth.initializeAuthSession()).phase).toBe('signedOut');
  await login();
  permission = deferred<MediaStream>();
  trackStop = vi.fn();
  stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  FakeRecorder.instances = [];
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => permission.promise) } });
  useVoiceInput = (await import('@/modules/chat/hooks/useVoiceInput')).useVoiceInput;
});
afterEach(() => { vi.unstubAllGlobals(); });

test('normal recording releases tracks at stop and delivers the trimmed transcript with send intent', async () => {
  const captured = auth.getAuthSessionSnapshot();
  transport.transcribe.mockResolvedValue(new Response(JSON.stringify({ text: '  hello voice  ' })));
  const hook = renderVoice();
  const recorder = await record(hook);
  act(() => hook.result.current.stop({ send: true }));
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(transport.transcribe).not.toHaveBeenCalled();
  await act(async () => { await recorder.finish(); });
  expect(transport.transcribe.mock.calls[0][3]).toBe(captured);
  expect(transport.transcribe.mock.calls[0][0].size).toBe(1000);
  expect(hook.transcript).toHaveBeenCalledExactlyOnceWith('hello voice', true);
  expect(hook.error).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe('idle');
});

test.each(['logout', 'server switch', 'replacement login'] as const)('pending microphone permission is fenced by %s', async transition => {
  const hook = renderVoice();
  act(() => hook.result.current.toggle());
  await act(async () => {
    if (transition === 'logout') await auth.clearAuthToken();
    else if (transition === 'server switch') auth.beginAuthServerSwitch();
    else await login('bob', 'newaccount');
  });
  await act(async () => { permission.resolve(stream); });
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(FakeRecorder.instances).toHaveLength(0);
  expect(transport.transcribe).not.toHaveBeenCalled();
  expect(hook.transcript).not.toHaveBeenCalled();
  expect(hook.error).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe('idle');
});

test.each(['logout', 'server switch'] as const)('%s while recording stops the recorder/tracks and suppresses queued browser events', async transition => {
  const hook = renderVoice(); const recorder = await record(hook);
  const queuedData = recorder.ondataavailable!; const queuedStop = recorder.onstop!;
  await act(async () => {
    if (transition === 'logout') await auth.clearAuthToken();
    else auth.beginAuthServerSwitch();
  });
  expect(recorder.stop).toHaveBeenCalledTimes(1);
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(recorder.ondataavailable).toBeNull(); expect(recorder.onstop).toBeNull();
  await act(async () => { queuedData({ data: new Blob(['a'.repeat(1000)]) }); await queuedStop(); });
  expect(transport.transcribe).not.toHaveBeenCalled();
  expect(hook.transcript).not.toHaveBeenCalled();
  expect(hook.error).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe('idle');
});

test('a failing recorder stop cannot keep the microphone open during account revocation', async () => {
  const hook = renderVoice(); const recorder = await record(hook);
  recorder.stop.mockImplementation(() => { throw new Error('browser stop failed'); });
  await act(async () => { await auth.clearAuthToken(); });
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(hook.error).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe('idle');
});

test('same-incarnation token refresh during permission and recording does not cancel dictation', async () => {
  const captured = auth.getAuthSessionSnapshot();
  transport.transcribe.mockResolvedValue(new Response(JSON.stringify({ text: 'keep recording' })));
  const hook = renderVoice();
  act(() => hook.result.current.toggle());
  await act(async () => {
    expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true);
    permission.resolve(stream);
  });
  expect(auth.getAuthSessionSnapshot()).toMatchObject({ phase: 'ready', sessionInstanceId: captured.sessionInstanceId, tokenRevision: 1 });
  expect(trackStop).not.toHaveBeenCalled();
  act(() => hook.result.current.stop());
  await act(async () => { await FakeRecorder.instances[0].finish(); });
  expect(transport.transcribe.mock.calls[0][3]).toBe(captured);
  expect(hook.transcript).toHaveBeenCalledExactlyOnceWith('keep recording', false);
});

test('switching before the delayed recorder stop event discards chunks and stops tracks immediately', async () => {
  const hook = renderVoice();
  const recorder = await record(hook);
  const queuedStop = recorder.onstop!;
  act(() => hook.result.current.stop({ send: true }));
  await act(async () => { await login('bob'); await queuedStop(); });
  expect(trackStop).toHaveBeenCalledTimes(1);
  expect(transport.transcribe).not.toHaveBeenCalled();
  expect(hook.transcript).not.toHaveBeenCalled();
});

test('a late transcription response is fenced before starting JSON consumption', async () => {
  const response = deferred<Response>();
  transport.transcribe.mockReturnValue(response.promise);
  const hook = renderVoice();
  const recorder = await record(hook);
  act(() => hook.result.current.stop({ send: true }));
  let completion: Promise<void> | void;
  act(() => { completion = recorder.finish(); });
  const signal = transport.transcribe.mock.calls[0][2] as AbortSignal;
  await act(async () => { await login('bob', 'replacement'); });
  expect(signal.aborted).toBe(true);
  const json = vi.fn(async () => ({ text: 'old account text' }));
  await act(async () => { response.resolve({ ok: true, json } as unknown as Response); await completion; });
  expect(json).not.toHaveBeenCalled();
  expect(hook.transcript).not.toHaveBeenCalled();
  expect(hook.error).not.toHaveBeenCalled();
});

test.each(['resolve', 'reject'] as const)('logout while JSON is pending suppresses old transcript/error on %s', async outcome => {
  const data = deferred<{ text: string }>();
  const json = vi.fn(() => data.promise);
  transport.transcribe.mockResolvedValue({ ok: true, json });
  const hook = renderVoice();
  const recorder = await record(hook);
  act(() => hook.result.current.stop({ send: true }));
  let completion: Promise<void> | void;
  await act(async () => { completion = recorder.finish(); await Promise.resolve(); });
  expect(json).toHaveBeenCalledTimes(1);
  const signal = transport.transcribe.mock.calls[0][2] as AbortSignal;
  await act(async () => { await auth.clearAuthToken(); });
  expect(signal.aborted).toBe(true);
  await act(async () => {
    if (outcome === 'resolve') data.resolve({ text: 'late' });
    else data.reject(new Error('old request failure'));
    await completion;
  });
  expect(hook.transcript).not.toHaveBeenCalled();
  expect(hook.error).not.toHaveBeenCalled();
  expect(hook.result.current.state).toBe('idle');
});

test('token refresh during transcription JSON keeps the original capture and delivers its transcript', async () => {
  const data = deferred<{ text: string }>();
  const json = vi.fn(() => data.promise);
  transport.transcribe.mockResolvedValue({ ok: true, json });
  const captured = auth.getAuthSessionSnapshot();
  const hook = renderVoice(); const recorder = await record(hook);
  act(() => hook.result.current.stop({ send: true }));
  let completion: Promise<void> | void;
  await act(async () => { completion = recorder.finish(); await Promise.resolve(); });
  expect(json).toHaveBeenCalledTimes(1);
  await act(async () => { expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true); });
  expect((transport.transcribe.mock.calls[0][2] as AbortSignal).aborted).toBe(false);
  expect(transport.transcribe.mock.calls[0][3]).toBe(captured);
  await act(async () => { data.resolve({ text: 'same recording' }); await completion; });
  expect(hook.transcript).toHaveBeenCalledExactlyOnceWith('same recording', true);
  expect(hook.error).not.toHaveBeenCalled();
});

test('unmount cancels a pending microphone without surfacing a late permission error', async () => {
  const hook = renderVoice();
  act(() => hook.result.current.toggle());
  hook.unmount();
  await act(async () => { permission.reject(new DOMException('denied', 'NotAllowedError')); });
  expect(hook.error).not.toHaveBeenCalled();
  expect(transport.transcribe).not.toHaveBeenCalled();
});
