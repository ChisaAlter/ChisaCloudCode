import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type * as Auth from '@/modules/auth-session';
import type * as Available from '@/modules/chat/hooks/useVoiceAvailable';
import type * as Voice from '@/modules/voice';

const transport = vi.hoisted(() => ({ health: vi.fn(), enabled: true }));
vi.mock('@/shared/api', () => ({ api: { voice: { health: transport.health } } }));
vi.mock('@/shared/context/UiPreferencesContext', () => ({ useUiPreferences: () => ({ voiceEnabled: transport.enabled }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function token(userId: string, signature = 'signature') {
  return `e30.${Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.${signature}`;
}
// Fresh modules keep the health dedup map and credential revisions isolated while auth remains the real authority.
let auth: typeof Auth;
let voice: typeof Voice;
let useVoiceAvailable: typeof Available.useVoiceAvailable;
async function login(user = 'alice') {
  const session = await auth.startAuthSession(token(user), auth.getAuthSessionSnapshot());
  expect(session).not.toBeNull();
  auth.acknowledgeAuthSession(session!);
  return session!;
}
const configured = (value: boolean) => new Response(JSON.stringify({ configured: value }));

beforeEach(async () => {
  vi.resetModules();
  transport.health.mockReset(); transport.enabled = true;
  localStorage.clear(); sessionStorage.clear();
  auth = await import('@/modules/auth-session');
  await auth.initializeAuthSession();
  await login();
  voice = await import('@/modules/voice');
  useVoiceAvailable = (await import('@/modules/chat/hooks/useVoiceAvailable')).useVoiceAvailable;
});
afterEach(() => { vi.unstubAllGlobals(); });

test('concurrent consumers deduplicate health only within one account and configuration revision', async () => {
  const first = deferred<Response>();
  transport.health.mockReturnValue(first.promise);
  const hook = renderHook(() => [useVoiceAvailable(), useVoiceAvailable()]);
  expect(hook.result.current).toEqual([false, false]);
  expect(transport.health).toHaveBeenCalledTimes(1);
  expect(transport.health.mock.calls[0][0].expectedSession).toBe(auth.getAuthSessionSnapshot());
  await act(async () => { first.resolve(configured(true)); });
  expect(hook.result.current).toEqual([true, true]);
});

test('same-incarnation ready token refresh reuses the pending health check', async () => {
  const first = deferred<Response>();
  transport.health.mockReturnValue(first.promise);
  const captured = auth.getAuthSessionSnapshot();
  const hook = renderHook(() => useVoiceAvailable());
  const signal = transport.health.mock.calls[0][0].signal as AbortSignal;
  await act(async () => { expect(await auth.storeAuthToken(token('alice', 'rotated'), captured)).toBe(true); });
  expect(signal.aborted).toBe(false);
  expect(transport.health).toHaveBeenCalledTimes(1);
  await act(async () => { first.resolve(configured(true)); });
  expect(hook.result.current).toBe(true);
  await act(async () => { expect(await auth.storeAuthToken(token('alice', 'rotatedagain'), auth.getAuthSessionSnapshot())).toBe(true); });
  expect(transport.health).toHaveBeenCalledTimes(1);
  expect(hook.result.current).toBe(true);
});

test('a replacement login starts a separate health check and ignores the old response before JSON', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  transport.health.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const hook = renderHook(() => useVoiceAvailable());
  const oldSignal = transport.health.mock.calls[0][0].signal as AbortSignal;
  await act(async () => { await login('bob'); });
  expect(oldSignal.aborted).toBe(true);
  expect(transport.health).toHaveBeenCalledTimes(2);
  expect(transport.health.mock.calls[1][0].expectedSession.userId).toBe('bob');
  const oldJson = vi.fn(async () => ({ configured: true }));
  await act(async () => { first.resolve({ ok: true, json: oldJson } as unknown as Response); });
  expect(oldJson).not.toHaveBeenCalled();
  expect(hook.result.current).toBe(false);
  await act(async () => { second.resolve(configured(false)); });
  expect(hook.result.current).toBe(false);
});

test('config revision cancels old health JSON and keeps the replacement result', async () => {
  const data = deferred<{ configured: boolean }>();
  const second = deferred<Response>();
  const oldJson = vi.fn(() => data.promise);
  transport.health.mockResolvedValueOnce({ ok: true, json: oldJson }).mockReturnValueOnce(second.promise);
  const hook = renderHook(() => useVoiceAvailable());
  await act(async () => { await Promise.resolve(); });
  expect(oldJson).toHaveBeenCalledTimes(1);
  const oldSignal = transport.health.mock.calls[0][0].signal as AbortSignal;
  act(() => { voice.writeVoiceConfig({ sttModel: 'new-model' }); });
  expect(oldSignal.aborted).toBe(true);
  expect(transport.health).toHaveBeenCalledTimes(2);
  await act(async () => { second.resolve(configured(false)); data.resolve({ configured: true }); });
  expect(hook.result.current).toBe(false);
});

test('logout hides available voice immediately and aborts health body parsing', async () => {
  const data = deferred<{ configured: boolean }>();
  transport.health.mockResolvedValue({ ok: true, json: () => data.promise });
  const hook = renderHook(() => useVoiceAvailable());
  await act(async () => { await Promise.resolve(); });
  const signal = transport.health.mock.calls[0][0].signal as AbortSignal;
  await act(async () => { await auth.clearAuthToken(); });
  expect(signal.aborted).toBe(true);
  await act(async () => { data.resolve({ configured: true }); });
  expect(hook.result.current).toBe(false);
});

test('direct voice configuration enables controls without proxy health and respects the preference', () => {
  voice.writeVoiceConfig({ baseUrl: 'https://voice.example/v1' });
  const hook = renderHook(() => useVoiceAvailable());
  expect(hook.result.current).toBe(true);
  expect(transport.health).not.toHaveBeenCalled();
  transport.enabled = false;
  hook.rerender();
  expect(hook.result.current).toBe(false);
});

test('failed or malformed health data does not enable controls', async () => {
  transport.health.mockResolvedValue(new Response('bad data'));
  const hook = renderHook(() => useVoiceAvailable());
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current).toBe(false);
});
