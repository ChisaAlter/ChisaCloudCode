import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { i18n } from '@/modules/i18n';
import {
  acknowledgeAuthSession, clearAuthToken, getAuthSessionSnapshot, initializeAuthSession,
  startAuthSession, storeAuthToken, synchronizeAuthSession,
} from '@/modules/auth-session';
import type { AuthSessionSnapshot } from '@/shared/types';
import type * as WebRevocationModule from '@/modules/auth/web-revocation.service';

vi.mock('@/modules/auth/web-revocation.service', async importOriginal => {
  const original = await importOriginal<typeof WebRevocationModule>();
  const { createRevocationQueueFixture } = await import('@/modules/auth/tests/fixtures/webRevocationQueue');
  const { endAuthSessionWithRevocation } = await import('@/shared/authToken');
  const { api } = await import('@/shared/api');
  const service = original.createWebRevocationService({ end: endAuthSessionWithRevocation, queue: createRevocationQueueFixture().queue,
    serverKey: () => location.origin, request: (token, server) => api.auth.revokeCapturedWebSession(token, server) });
  return { ...original, logoutWebSession: service.logout, retryWebRevocations: service.retry, pendingWebRevocations: service.pending };
});

const fixture = vi.hoisted(() => ({
  user: vi.fn(), updateProfile: vi.fn(), login: vi.fn(), refresh: vi.fn(), onboardingStatus: vi.fn(), revokeCapturedWebSession: vi.fn(),
  getApiConnection: vi.fn(), endServerSession: vi.fn(), desktop: false,
  responseSessions: new WeakMap<Response, AuthSessionSnapshot>(),
}));
vi.mock('@/shared/api', () => ({
  ServiceConnectionError: class extends Error {},
  getResponseAuthSession: (response: Response) => fixture.responseSessions.get(response),
  readApiErrorMessage: (payload: { error?: string | { message?: string } } | null) => typeof payload?.error === 'string'
    ? payload.error : payload?.error?.message,
  api: { auth: fixture, user: { onboardingStatus: fixture.onboardingStatus } },
}));
vi.mock('@/shared/chatDrafts', () => ({ hydrateChatDrafts: vi.fn(), resetChatDrafts: vi.fn() }));
vi.mock('@/shared/userSettings', () => ({
  hydrateUserPreferences: vi.fn(), resetUserPreferences: vi.fn(),
  readUserPreference: (_key: string, fallback: unknown) => fallback,
  subscribeToUserPreferences: () => () => {}, writeUserPreference: vi.fn(),
}));
vi.mock('@/shared/chisa', () => ({
  isDesktop: () => fixture.desktop,
  FrontendBridge: { getApiConnection: fixture.getApiConnection, endServerSession: fixture.endServerSession },
}));
vi.mock('@/modules/onboarding', () => ({ Onboarding: () => <p>onboarding</p> }));
vi.mock('@/modules/auth/AuthLoadingScreen', () => ({ default: () => <p>loading account</p> }));
vi.mock('@/modules/auth/LoginForm', () => ({ default: () => <p>signed out</p> }));
vi.mock('@/modules/auth/SignedOutDesktop', () => ({ SignedOutDesktop: () => <p>desktop signed out</p> }));

const USER = { id: 1, username: 'ayase' };
const OTHER_USER = { id: 2, username: 'other-account' };
const LATEST_USER = { id: 3, username: 'latest-account' };
function token(userId = 1, revision = 'initial'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId, revision, sid: 'auth-session-' + userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.signature`;
}
const INITIAL_TOKEN = token();
function captured(response: Response, session = getAuthSessionSnapshot()): Response {
  // API records the identity at dispatch/accepted native handoff, never at a later JSON resolution.
  fixture.responseSessions.set(response, session);
  return response;
}
function json(value: unknown, session = getAuthSessionSnapshot()): Response {
  return captured(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }), session);
}
function denied(status: number, session = getAuthSessionSnapshot()): Response {
  return captured(new Response('Account access denied', { status }), session);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function delayedJson(session: AuthSessionSnapshot) {
  const body = deferred<unknown>();
  const response = json({}, session);
  const read = vi.spyOn(response, 'json').mockImplementation(() => body.promise);
  return { response, read, resolve: body.resolve };
}
async function replaceIdentity(nextToken: string) {
  const next = await startAuthSession(nextToken, getAuthSessionSnapshot());
  assert.ok(next, 'the explicit current authority predecessor must commit');
  return next;
}

let auth!: ReturnType<typeof useAuth>;
let mounts = 0;
function AccountProbe() {
  const account = useAuth();
  useEffect(() => { auth = account; }, [account]);
  return <p>{account.user?.displayName || account.user?.username || 'no account'}</p>;
}
function WorkspaceProbe() {
  useEffect(() => { mounts += 1; }, []);
  return <input aria-label="workspace buffer" defaultValue="original" />;
}
function renderAccount() {
  return render(<AuthProvider><AccountProbe /><ProtectedRoute><WorkspaceProbe /></ProtectedRoute></AuthProvider>);
}
async function mount() {
  renderAccount();
  await waitFor(() => assert.ok(screen.getByLabelText('workspace buffer')));
}

beforeEach(async () => {
  vi.resetAllMocks();
  fixture.desktop = false;
  fixture.responseSessions = new WeakMap();
  mounts = 0;
  // jsdom has no navigator.locks: this fixture intentionally exercises the isolated window authority.
  assert.equal(navigator.locks, undefined);
  await initializeAuthSession();
  await clearAuthToken(getAuthSessionSnapshot());
  localStorage.clear();
  sessionStorage.clear();
  await synchronizeAuthSession();
  const initial = await replaceIdentity(INITIAL_TOKEN);
  acknowledgeAuthSession(initial);
  await i18n.changeLanguage('en');
  assert.equal(initial.storageMode, 'window');
  fixture.revokeCapturedWebSession.mockImplementation(() => Promise.resolve(json({ success: true })));
  fixture.user.mockImplementation(() => Promise.resolve(json({ user: USER })));
  fixture.onboardingStatus.mockImplementation(() => Promise.resolve(json({ hasCompletedOnboarding: true })));
  fixture.getApiConnection.mockImplementation(async () => ({
    authenticated: Boolean(getAuthSessionSnapshot().token), restorationToken: '',
  }));
});
afterEach(async () => {
  cleanup();
  await clearAuthToken(getAuthSessionSnapshot());
  vi.useRealTimers();
});

test('JWT rotation retains the workspace and unsaved input without repeating startup account checks', async () => {
  await mount();
  const input = screen.getByLabelText('workspace buffer') as HTMLInputElement;
  input.value = 'unsaved local draft';
  const before = getAuthSessionSnapshot();
  const rotated = token(1, 'rotated');
  await act(async () => { assert.equal(await storeAuthToken(rotated, before), true); });
  assert.equal(fixture.user.mock.calls.length, 1);
  assert.equal(auth.token, rotated);
  assert.equal(getAuthSessionSnapshot().sessionInstanceId, before.sessionInstanceId);
  assert.equal(screen.queryByText('loading account'), null);
  assert.equal(screen.getByLabelText('workspace buffer'), input);
  assert.equal(input.value, 'unsaved local draft');
  assert.equal(mounts, 1);
});

test('logout rejects a late profile save and a late auth check without reviving the account', async () => {
  await mount();
  const predecessor = getAuthSessionSnapshot();
  const profile = deferred<Response>();
  const checked = deferred<Response>();
  fixture.updateProfile.mockReturnValue(profile.promise);
  fixture.user.mockReturnValue(checked.promise);
  let update!: ReturnType<typeof auth.updateProfile>;
  let checking!: Promise<void>;
  act(() => { update = auth.updateProfile('new name', null); checking = auth.refreshAuthStatus(); });
  await waitFor(() => assert.equal(fixture.user.mock.calls.length, 2));
  await act(async () => { auth.logout(); await synchronizeAuthSession(); });
  await act(async () => {
    profile.resolve(json({ user: { ...USER, displayName: 'old saved response' } }, predecessor));
    checked.resolve(json({ user: USER }, predecessor));
    assert.equal((await update).success, false);
    await checking;
  });
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.equal(auth.user, null);
  assert.equal(getAuthSessionSnapshot().token, null);
  assert.ok(screen.getByText('signed out'));
});

test('offline startup retains the stored session and online automatically restores it', async () => {
  fixture.user.mockRejectedValueOnce(new TypeError('offline'));
  renderAccount();
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.equal(auth.user, null);
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.equal(getAuthSessionSnapshot().token, INITIAL_TOKEN);
  assert.ok(auth.error, 'connectivity failure remains visible while the stored token is retained');
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => assert.equal(auth.user?.id, 1));
  assert.ok(screen.getByLabelText('workspace buffer'));
  assert.equal(fixture.login.mock.calls.length, 0);
});

test('offline startup keeps automatic scheduled recovery enabled without resubmitting login', async () => {
  vi.useFakeTimers();
  fixture.user.mockRejectedValueOnce(new TypeError('offline until scheduled retry'));
  renderAccount();
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  assert.equal(auth.isLoading, false);
  assert.equal(auth.user, null);
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.ok(auth.error);
  assert.equal(fixture.user.mock.calls.length, 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); });
  assert.equal(fixture.user.mock.calls.length, 1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  assert.deepEqual(auth.user, USER);
  assert.equal(auth.isLoading, false);
  assert.equal(fixture.user.mock.calls.length, 2);
  assert.equal(fixture.login.mock.calls.length, 0);
  assert.ok(screen.getByLabelText('workspace buffer'));
});

test('logout invalidates scheduled connectivity retries and late responses', async () => {
  fixture.user.mockResolvedValueOnce(captured(new Response('offline', { status: 503 })));
  renderAccount();
  await waitFor(() => assert.equal(auth.isLoading, false));
  await act(async () => { auth.logout(); await synchronizeAuthSession(); });
  const count = fixture.user.mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); });
  assert.equal(fixture.user.mock.calls.length, count);
  assert.equal(auth.user, null);
  assert.equal(auth.token, null);
});

test('an initial 502 preserves the stored session and manual account refresh can recover it', async () => {
  fixture.user.mockResolvedValueOnce(captured(new Response('Bad Gateway', { status: 502 })));
  renderAccount();
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.equal(getAuthSessionSnapshot().token, INITIAL_TOKEN);
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.equal(auth.user, null);
  assert.ok(auth.error);
  assert.equal(screen.queryByText('loading account'), null);
  assert.equal(mounts, 0);
  await act(async () => { await auth.refreshAuthStatus(); });
  assert.ok(screen.getByText('ayase'));
  assert.equal(auth.error, null);
  assert.equal(getAuthSessionSnapshot().token, INITIAL_TOKEN);
  assert.ok(screen.getByLabelText('workspace buffer'));
  assert.equal(mounts, 1);
});

test('a 503 account check retains the mounted workspace and its unsaved input', async () => {
  await mount();
  const input = screen.getByLabelText('workspace buffer') as HTMLInputElement;
  input.value = 'unsaved workspace content';
  fixture.user.mockResolvedValueOnce(captured(new Response('Service Unavailable', { status: 503 })));
  await act(async () => { await auth.refreshAuthStatus(); });
  assert.equal(auth.user?.username, 'ayase');
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.equal(getAuthSessionSnapshot().token, INITIAL_TOKEN);
  assert.ok(auth.error);
  assert.equal(auth.isLoading, false);
  assert.equal(screen.getByLabelText('workspace buffer'), input);
  assert.equal(input.value, 'unsaved workspace content');
  assert.equal(screen.queryByText('signed out'), null);
  assert.equal(mounts, 1);
});

test.each([401, 403])('a %s account response clears the stored session and removes the protected workspace', async status => {
  await mount();
  fixture.user.mockResolvedValueOnce(denied(status));
  await act(async () => { await auth.refreshAuthStatus(); await synchronizeAuthSession(); });
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.equal(auth.user, null);
  assert.equal(auth.token, null);
  assert.equal(getAuthSessionSnapshot().token, null);
  assert.equal(screen.queryByLabelText('workspace buffer'), null);
  assert.ok(screen.getByText('signed out'));
});

test('initial signed-out authority settles without account checks or a permanent loading gate', async () => {
  await clearAuthToken(getAuthSessionSnapshot());
  renderAccount();
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.equal(auth.user, null);
  assert.equal(auth.token, null);
  assert.equal(fixture.user.mock.calls.length, 0);
  assert.ok(screen.getByText('signed out'));
});

test('first AuthContext login commits the captured signed-out predecessor and publishes the real user', async () => {
  await clearAuthToken(getAuthSessionSnapshot());
  fixture.login.mockImplementation(async () => json({ token: INITIAL_TOKEN, user: USER }));
  renderAccount();
  await screen.findByText('signed out');
  let result!: Awaited<ReturnType<typeof auth.login>>;
  await act(async () => { result = await auth.login('ayase', 'fixture-password'); });
  assert.equal(result.success, true);
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.deepEqual(auth.user, USER);
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.equal(getAuthSessionSnapshot().phase, 'ready');
  assert.ok(screen.getByLabelText('workspace buffer'));
  assert.equal(mounts, 1);
});

test('an identity replacement clears the old profile immediately and converges to the new account', async () => {
  await mount();
  const pending = deferred<Response>();
  let replacement!: AuthSessionSnapshot;
  fixture.user.mockImplementationOnce(() => pending.promise);
  await act(async () => { replacement = await replaceIdentity(token(2)); });
  await waitFor(() => assert.equal(fixture.user.mock.calls.length, 2));
  assert.equal(auth.user, null);
  assert.equal(screen.queryByText('ayase'), null);
  assert.equal(screen.queryByLabelText('workspace buffer'), null);
  await act(async () => { pending.resolve(json({ user: OTHER_USER }, replacement)); });
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.deepEqual(auth.user, OTHER_USER);
  assert.ok(screen.getByLabelText('workspace buffer'));
});

test('two adjacent identity replacements cannot let late account JSON take over the latest identity', async () => {
  await mount();
  let late!: ReturnType<typeof delayedJson>;
  fixture.user.mockImplementationOnce(async () => {
    late = delayedJson(getAuthSessionSnapshot());
    return late.response;
  });
  await act(async () => { await replaceIdentity(token(2)); });
  await waitFor(() => assert.equal(late?.read.mock.calls.length, 1));
  assert.equal(auth.user, null);
  fixture.user.mockImplementationOnce(async () => json({ user: LATEST_USER }));
  await act(async () => { await replaceIdentity(token(3)); });
  await waitFor(() => assert.equal(auth.user?.id, 3));
  await act(async () => { late.resolve({ user: OTHER_USER }); });
  assert.deepEqual(auth.user, LATEST_USER);
  assert.equal(auth.token, token(3));
  assert.equal(auth.isLoading, false);
  assert.equal(screen.queryByText('other-account'), null);
});

test('late login JSON cannot replace either of two later committed identities', async () => {
  await clearAuthToken(getAuthSessionSnapshot());
  const predecessor = getAuthSessionSnapshot();
  const late = delayedJson(predecessor);
  fixture.login.mockResolvedValueOnce(late.response);
  renderAccount();
  await screen.findByText('signed out');
  let login!: ReturnType<typeof auth.login>;
  act(() => { login = auth.login('ayase', 'fixture-password'); });
  await waitFor(() => assert.equal(late.read.mock.calls.length, 1));
  fixture.user.mockImplementation(async () => json({ user: getAuthSessionSnapshot().userId === '2' ? OTHER_USER : LATEST_USER }));
  await act(async () => { await replaceIdentity(token(2)); });
  await waitFor(() => assert.equal(auth.user?.id, 2));
  await act(async () => { await replaceIdentity(token(3)); });
  await waitFor(() => assert.equal(auth.user?.id, 3));
  await act(async () => { late.resolve({ user: USER, token: INITIAL_TOKEN }); assert.equal((await login).success, false); });
  assert.deepEqual(auth.user, LATEST_USER);
  assert.equal(auth.token, token(3));
  assert.equal(auth.isLoading, false);
});

test.each([401, 403])('an old %s account reply cannot sign out a newer verified identity', async status => {
  await mount();
  const oldSession = getAuthSessionSnapshot();
  const oldResponse = deferred<Response>();
  fixture.user.mockReturnValueOnce(oldResponse.promise);
  let checking!: Promise<void>;
  act(() => { checking = auth.refreshAuthStatus(); });
  await waitFor(() => assert.equal(fixture.user.mock.calls.length, 2));
  fixture.user.mockImplementationOnce(async () => json({ user: OTHER_USER }));
  await act(async () => { await replaceIdentity(token(2)); });
  await waitFor(() => assert.equal(auth.user?.id, 2));
  await act(async () => { oldResponse.resolve(denied(status, oldSession)); await checking; });
  assert.deepEqual(auth.user, OTHER_USER);
  assert.equal(auth.token, token(2));
  assert.equal(auth.isLoading, false);
});

test.each([401, 403])('an old token-revision %s account reply cannot revoke the freshly rotated credential', async status => {
  await mount();
  const input = screen.getByLabelText('workspace buffer') as HTMLInputElement;
  input.value = 'keep after late credential rejection';
  const oldSession = getAuthSessionSnapshot();
  const oldResponse = deferred<Response>();
  fixture.user.mockReturnValueOnce(oldResponse.promise);
  let checking!: Promise<void>;
  act(() => { checking = auth.refreshAuthStatus(); });
  await waitFor(() => assert.equal(fixture.user.mock.calls.length, 2));
  const rotated = token(1, 'fresh-after-account-check');
  await act(async () => { assert.equal(await storeAuthToken(rotated, oldSession), true); });
  const current = getAuthSessionSnapshot();
  assert.equal(current.sessionInstanceId, oldSession.sessionInstanceId);
  assert.equal(current.tokenRevision, oldSession.tokenRevision + 1);
  await act(async () => { oldResponse.resolve(denied(status, oldSession)); await checking; });
  assert.deepEqual(auth.user, USER);
  assert.equal(auth.token, rotated);
  assert.equal(getAuthSessionSnapshot().token, rotated);
  assert.equal(auth.isLoading, false);
  assert.equal(screen.getByLabelText('workspace buffer'), input);
  assert.equal(input.value, 'keep after late credential rejection');
  assert.equal(mounts, 1);
});

test('a late profile response cannot overwrite the replacement identity', async () => {
  await mount();
  const predecessor = getAuthSessionSnapshot();
  const profile = deferred<Response>();
  fixture.updateProfile.mockReturnValueOnce(profile.promise);
  let update!: ReturnType<typeof auth.updateProfile>;
  act(() => { update = auth.updateProfile('late old name', null); });
  fixture.user.mockImplementationOnce(async () => json({ user: OTHER_USER }));
  await act(async () => { await replaceIdentity(token(2)); });
  await waitFor(() => assert.equal(auth.user?.id, 2));
  await act(async () => {
    profile.resolve(json({ user: { ...USER, displayName: 'late old name' } }, predecessor));
    assert.equal((await update).success, false);
  });
  assert.deepEqual(auth.user, OTHER_USER);
  assert.equal(screen.queryByText('late old name'), null);
});

test('AuthContext accepts a mocked native auth-user restoration handoff and settles the new identity', async () => {
  await clearAuthToken(getAuthSessionSnapshot());
  fixture.desktop = true;
  fixture.getApiConnection.mockImplementation(async () => ({
    authenticated: Boolean(getAuthSessionSnapshot().token), restorationToken: 'fixture-restoration-token',
  }));
  fixture.user.mockImplementationOnce(async () => {
    const accepted = await replaceIdentity(INITIAL_TOKEN);
    return json({ user: USER }, accepted);
  });
  renderAccount();
  await waitFor(() => assert.deepEqual(auth.user, USER));
  assert.equal(auth.isLoading, false);
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.ok(screen.getByLabelText('workspace buffer'));
});

test('native explicit logout shows a pending receipt and a replacement login never inherits its notice', async () => {
  await mount();
  fixture.desktop = true;
  fixture.endServerSession.mockImplementationOnce(async () => {
    await clearAuthToken(getAuthSessionSnapshot());
    return { ok: true, connection: { sessionHandle: getAuthSessionSnapshot().sessionInstanceId }, receipt: { localCleared: true, remoteRevoked: false, pendingRevocation: true, remoteStatus: 'pending' } };
  });
  await act(async () => { auth.logout(); await synchronizeAuthSession(); });
  await screen.findByText('已退出本地登录，服务器会话吊销待确认；恢复连接后会继续重试。');
  assert.equal(auth.user, null); assert.equal(auth.token, null);
  fixture.user.mockImplementationOnce(async () => json({ user: OTHER_USER }));
  await act(async () => { await replaceIdentity(token(2)); });
  await waitFor(() => assert.equal(auth.user?.id, 2));
  assert.equal(screen.queryByText('已退出本地登录，服务器会话吊销待确认；恢复连接后会继续重试。'), null);
});

test('AuthContext accepts a mocked native login handoff using its accepted response identity', async () => {
  await clearAuthToken(getAuthSessionSnapshot());
  fixture.desktop = true;
  fixture.login.mockImplementationOnce(async () => {
    // This models only AuthContext's handoff boundary: the real bridge is tested by its owning transport suite.
    const accepted = await replaceIdentity(INITIAL_TOKEN);
    return json({ token: INITIAL_TOKEN, user: USER }, accepted);
  });
  renderAccount();
  await screen.findByText('desktop signed out');
  let result!: Awaited<ReturnType<typeof auth.login>>;
  await act(async () => { result = await auth.login('ayase', 'fixture-password'); });
  assert.equal(result.success, true);
  await waitFor(() => assert.equal(auth.isLoading, false));
  assert.deepEqual(auth.user, USER);
  assert.equal(auth.token, INITIAL_TOKEN);
  assert.ok(screen.getByLabelText('workspace buffer'));
});
