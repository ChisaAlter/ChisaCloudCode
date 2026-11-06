import { Buffer } from 'node:buffer';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { acknowledgeAuthSession, clearAuthToken, dispatchWithAuthSession, getAuthSessionSnapshot, initializeAuthSession, startAuthSession, synchronizeAuthSession } from '@/modules/auth-session';
import { api } from '@/shared/api';
import { i18n } from '@/modules/i18n';
import type * as WebRevocationModule from '@/modules/auth/web-revocation.service';
import type { createRevocationQueueFixture } from '@/modules/auth/tests/fixtures/webRevocationQueue';

vi.mock('@/shared/chatDrafts', () => ({ hydrateChatDrafts: vi.fn(), resetChatDrafts: vi.fn() }));
vi.mock('@/shared/userSettings', () => ({ hydrateUserPreferences: vi.fn(), resetUserPreferences: vi.fn(),
  readUserPreference: (_key: string, fallback: unknown) => fallback, subscribeToUserPreferences: () => () => {}, writeUserPreference: vi.fn(),
}));

const durable = vi.hoisted(() => ({ value: null as null | ReturnType<typeof createRevocationQueueFixture> }));
vi.mock('@/modules/auth/web-revocation.service', async importOriginal => {
  const original = await importOriginal<typeof WebRevocationModule>();
  const { createRevocationQueueFixture } = await import('@/modules/auth/tests/fixtures/webRevocationQueue');
  durable.value = createRevocationQueueFixture();
  const { endAuthSessionWithRevocation } = await import('@/shared/authToken');
  const { api } = await import('@/shared/api');
  const service = original.createWebRevocationService({ end: endAuthSessionWithRevocation, queue: durable.value.queue,
    serverKey: () => location.origin, request: (token, server) => api.auth.revokeCapturedWebSession(token, server) });
  return { ...original, logoutWebSession: service.logout, retryWebRevocations: service.retry, pendingWebRevocations: service.pending };
});
const requests: { path: string; token: string | null; init?: RequestInit }[] = [];
let remote: () => Promise<Response>;
let auth!: ReturnType<typeof useAuth>;
function credential(id: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return encode({ alg: 'HS256' }) + '.' + encode({ userId: id, sid: 'sid-' + id, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.signature';
}
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
function pending() { return [...durable.value!.entries.values()]; }
function Probe() {
  const value = useAuth(); useLayoutEffect(() => { auth = value; }, [value]);
  return <div>{value.user ? 'account-' + value.user.id : 'signed-out'}<button onClick={value.logout}>Logout</button></div>;
}
async function mount() { const view = render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(auth.isLoading).toBe(false)); return view; }
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  durable.value!.entries.clear(); durable.value!.state.failed = false;
  requests.length = 0; remote = async () => json({ success: true });
  await initializeAuthSession(); await clearAuthToken(getAuthSessionSnapshot()); sessionStorage.clear(); localStorage.clear(); await synchronizeAuthSession();
  const initial = await startAuthSession(credential(1)); acknowledgeAuthSession(initial!);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); const bearer = new Headers(init?.headers).get('Authorization'); requests.push({ path, token: bearer, init });
    if (path.endsWith('/api/auth/logout')) return remote();
    if (path === '/api/auth/user') return json({ user: { id: bearer?.includes(credential(2)) ? 2 : 1, username: 'fixture' } });
    if (path === '/api/user/onboarding-status') return json({ hasCompletedOnboarding: true });
    if (path === '/api/auth/login') return json({ token: credential(2), user: { id: 2, username: 'two' } });
    return json({});
  }));
});
afterEach(async () => { cleanup(); await clearAuthToken(getAuthSessionSnapshot()); vi.restoreAllMocks(); vi.unstubAllGlobals(); history.replaceState(null, '', '/'); });

test('real API sends logout A before local clear; a late ACK never clears or notices login B', async () => {
  const response = deferred<Response>(); remote = () => response.promise; await mount(); expect(auth.user?.id).toBe(1);
  const a = getAuthSessionSnapshot(); act(() => auth.logout()); expect(getAuthSessionSnapshot().phase).toBe('closing');
  await expect(dispatchWithAuthSession(a, async () => 'blocked')).rejects.toMatchObject({ name: 'AbortError' });
  await waitFor(() => expect(getAuthSessionSnapshot().phase).toBe('signedOut'));
  expect(requests.filter(value => value.path.endsWith('/api/auth/logout'))[0].token).toBe('Bearer ' + a.token);
  await act(async () => { const result = await auth.login('two', 'fixture'); expect(result.success).toBe(true); });
  const b = getAuthSessionSnapshot(); expect(auth.user?.id).toBe(2);
  await act(async () => { response.resolve(json({ success: true })); });
  expect(getAuthSessionSnapshot().sessionInstanceId).toBe(b.sessionInstanceId); expect(auth.user?.id).toBe(2);
  expect(screen.queryByText('服务器已确认退出登录。')).toBeNull(); expect(pending()).toHaveLength(0);
});

test('offline pending intent survives provider remount and retries original A while B stays signed in', async () => {
  remote = async () => { throw new TypeError('offline'); }; const view = await mount();
  const a = getAuthSessionSnapshot(); act(() => auth.logout());
  await waitFor(() => expect(getAuthSessionSnapshot().phase).toBe('signedOut'));
  await screen.findByText('已退出本地登录，服务器会话吊销待确认；恢复连接后会继续重试。'); expect(pending()).toHaveLength(1);
  view.unmount();
  await act(async () => { const b = await startAuthSession(credential(2)); acknowledgeAuthSession(b!); });
  remote = async () => json({ success: true }); await mount(); await waitFor(() => expect(auth.user?.id).toBe(2));
  await act(async () => window.dispatchEvent(new Event('online'))); await waitFor(() => expect(pending()).toHaveLength(0));
  const retries = requests.filter(value => value.path.endsWith('/api/auth/logout'));
  expect(retries.length).toBeGreaterThanOrEqual(2); for (const request of retries) expect(request.token).toBe('Bearer ' + a.token);
  expect(auth.user?.id).toBe(2); expect(screen.queryByText('服务器已确认退出登录。')).toBeNull();
});

test('storage failure keeps authority closing with a visible retry and no unrecorded logout request', async () => {
  await mount(); durable.value!.state.failed = true;
  act(() => auth.logout());
  await screen.findByText('注销记录未能安全保存，登录已暂停。请重试注销；尚未确认服务器会话吊销。');
  expect(getAuthSessionSnapshot().phase).toBe('closing'); expect(auth.user).toBeNull(); expect(auth.token).toBeNull();
  expect(requests.filter(value => value.path.endsWith('/api/auth/logout'))).toHaveLength(0);
  durable.value!.state.failed = false; await act(async () => auth.logout()); await waitFor(() => expect(getAuthSessionSnapshot().phase).toBe('signedOut'));
  await screen.findByText('服务器已确认退出登录。'); expect(pending()).toHaveLength(0);
});

test('a reloaded closing tombstone never bootstraps user or dispatches before retrying exact logout', async () => {
  const current = getAuthSessionSnapshot();
  const storageKey = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)!).find(key => key.startsWith('chisa-auth-window-session:v2:'))!;
  const closing = { ...current, phase: 'closing', revocationClosing: { version: 1, reason: 'explicit-logout', sessionInstanceId: current.sessionInstanceId, tokenRevision: current.tokenRevision } };
  sessionStorage.setItem(storageKey, JSON.stringify(closing)); await synchronizeAuthSession();
  await mount(); expect(getAuthSessionSnapshot().phase).toBe('closing'); expect(auth.user).toBeNull(); expect(auth.token).toBeNull();
  expect(requests.filter(value => value.path === '/api/auth/user')).toHaveLength(0);
  await expect(dispatchWithAuthSession(current, async () => 'unsafe')).rejects.toMatchObject({ name: 'AbortError' });
  await screen.findByText('登录已暂停，原会话注销尚未完成。请重试注销确认。');
  await act(async () => auth.logout()); await waitFor(() => expect(getAuthSessionSnapshot().phase).toBe('signedOut'));
  await screen.findByText('服务器已确认退出登录。');
  expect(requests.filter(value => value.path.endsWith('/api/auth/logout'))[0].token).toBe('Bearer ' + current.token);
});

test('captured revocation transport rejects foreign origin and preserves exact instance prefix', async () => {
  const a = getAuthSessionSnapshot();
  await expect(api.auth.revokeCapturedWebSession(a.token!, 'https://evil.test')).rejects.toThrow('does not match');
  expect(requests).toHaveLength(0);
  history.replaceState(null, '', '/instances/primary/settings');
  await api.auth.revokeCapturedWebSession(a.token!, location.origin + '/instances/primary');
  expect(requests[0]).toMatchObject({ path: '/instances/primary/api/auth/logout', token: 'Bearer ' + a.token,
    init: { credentials: 'omit', cache: 'no-store', redirect: 'error', method: 'POST' } });
  await expect(api.auth.revokeCapturedWebSession(a.token!, location.origin + '/instances/other')).rejects.toThrow('does not match');
});
