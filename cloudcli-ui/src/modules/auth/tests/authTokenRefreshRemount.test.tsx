import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { i18n } from '@/modules/i18n';
import type * as WebRevocationModule from '@/modules/auth/web-revocation.service';
import {
  acknowledgeAuthSession, clearAuthToken, getAuthSessionSnapshot, getAuthTokenRefreshDelay,
  initializeAuthSession, startAuthSession, storeAuthToken, synchronizeAuthSession,
} from '@/modules/auth-session';

vi.mock('@/modules/auth/web-revocation.service', async importOriginal => {
  const original = await importOriginal<typeof WebRevocationModule>();
  const { createRevocationQueueFixture } = await import('@/modules/auth/tests/fixtures/webRevocationQueue');
  const { endAuthSessionWithRevocation } = await import('@/shared/authToken');
  const { api } = await import('@/shared/api');
  const service = original.createWebRevocationService({ end: endAuthSessionWithRevocation, queue: createRevocationQueueFixture().queue,
    serverKey: () => location.origin, request: (token, server) => api.auth.revokeCapturedWebSession(token, server) });
  return { ...original, logoutWebSession: service.logout, retryWebRevocations: service.retry, pendingWebRevocations: service.pending };
});

/**
 * Issue #1269: credential rotation must not re-run the account bootstrap or
 * replace a mounted workspace. These fixtures use the real API transport and
 * authority so X-Refreshed-Token keeps its captured response predecessor.
 */
const makeToken = (issuedAtSeconds: number) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = { userId: 1, username: 'triage', iat: issuedAtSeconds, exp: issuedAtSeconds + 7 * 86400 };
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig${issuedAtSeconds}`;
};
const nowSeconds = () => Math.floor(Date.now() / 1000);

let requestedPaths: string[] = [];
let nextRefreshedToken: string | null = null;
let hasCompletedOnboarding = true;
let onboardingStatusDelayMs = 0;
let refreshToken: string | null = null;

const stubServer = () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    requestedPaths.push(url);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (url === '/api/auth/user' && nextRefreshedToken) headers['X-Refreshed-Token'] = nextRefreshedToken;
    if (url === '/api/user/onboarding-status' && onboardingStatusDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, onboardingStatusDelayMs));
    }
    const body = url === '/api/auth/status'
      ? { needsSetup: false }
      : url === '/api/auth/user'
        ? { user: { id: 1, username: 'triage' } }
        : url === '/api/auth/login'
          ? { token: makeToken(nowSeconds()), user: { id: 1, username: 'triage' } }
          : url === '/api/auth/refresh'
            ? { token: refreshToken ?? makeToken(nowSeconds()) }
            : url === '/api/user/onboarding-status'
              ? { hasCompletedOnboarding }
              : url.endsWith('/api/auth/logout') ? { success: true } : {};
    return new Response(JSON.stringify(body), { status: 200, headers });
  }));
};

let workspaceMounts = 0;
let loadingPasses = 0;
let seenToken: string | null = null;

function Workspace() {
  useEffect(() => { workspaceMounts += 1; }, []);
  return <div>workspace<input aria-label="unsaved workspace input" defaultValue="original" /></div>;
}
function LoadingScreen() {
  useEffect(() => { loadingPasses += 1; }, []);
  return <div>loading</div>;
}
function Gate() {
  const { isLoading, user, token, hasCompletedOnboarding: onboarded } = useAuth();
  useEffect(() => { seenToken = token; }, [token]);
  if (isLoading) return <LoadingScreen />;
  if (!user) return <div>login</div>;
  return onboarded ? <Workspace /> : <div>onboarding</div>;
}
const renderApp = () => render(<AuthProvider><Gate /></AuthProvider>);

async function signIn(credential: string) {
  const next = await startAuthSession(credential, getAuthSessionSnapshot());
  assert.ok(next, 'fixture login must use the current async authority predecessor');
  acknowledgeAuthSession(next);
  return next;
}
async function rotate(credential: string) {
  assert.equal(await storeAuthToken(credential, getAuthSessionSnapshot()), true);
}

beforeEach(async () => {
  assert.equal(navigator.locks, undefined, 'these tests intentionally use one isolated window authority');
  await initializeAuthSession();
  await clearAuthToken(getAuthSessionSnapshot());
  localStorage.clear();
  sessionStorage.clear();
  await synchronizeAuthSession();
  requestedPaths = [];
  nextRefreshedToken = null;
  hasCompletedOnboarding = true;
  onboardingStatusDelayMs = 0;
  refreshToken = null;
  workspaceMounts = 0;
  loadingPasses = 0;
  seenToken = null;
  stubServer();
});
afterEach(async () => {
  // Unmount before language/session reset so neither can dispatch into the next fixture.
  cleanup();
  vi.useRealTimers();
  await clearAuthToken(getAuthSessionSnapshot());
  await i18n.changeLanguage('en');
  vi.unstubAllGlobals();
});

test('a refreshed token on the initial auth check does not run a second loading pass', async () => {
  const agedToken = makeToken(nowSeconds() - 4 * 86400);
  const refreshedToken = makeToken(nowSeconds());
  const before = await signIn(agedToken);
  nextRefreshedToken = refreshedToken;
  renderApp();
  await screen.findByText('workspace');
  await act(async () => { await Promise.resolve(); });
  assert.equal(getAuthSessionSnapshot().token, refreshedToken);
  assert.equal(getAuthSessionSnapshot().sessionInstanceId, before.sessionInstanceId);
  assert.equal(seenToken, refreshedToken);
  assert.equal(requestedPaths.filter(path => path === '/api/auth/user').length, 1);
  assert.equal(loadingPasses, 1);
  assert.equal(workspaceMounts, 1);
  assert.ok(screen.getByText('workspace'));
});

test('tokens refreshed while the workspace is open do not remount it or discard unsaved input', async () => {
  await signIn(makeToken(nowSeconds() - 4 * 86400));
  renderApp();
  await screen.findByText('workspace');
  await waitFor(() => assert.ok(requestedPaths.includes('/api/auth/refresh'), 'an aged credential retains automatic refresh'));
  assert.equal(workspaceMounts, 1);
  const input = screen.getByLabelText('unsaved workspace input') as HTMLInputElement;
  input.value = 'unsaved local draft';
  const bootstrapRequests = requestedPaths.length;
  const before = getAuthSessionSnapshot();
  const rotations = [makeToken(nowSeconds() + 1), makeToken(nowSeconds() + 2), makeToken(nowSeconds() + 3)];
  for (const credential of rotations) {
    await act(async () => { await rotate(credential); });
  }
  assert.equal(seenToken, rotations[2]);
  assert.equal(getAuthSessionSnapshot().sessionInstanceId, before.sessionInstanceId);
  assert.equal(workspaceMounts, 1);
  assert.equal(loadingPasses, 1);
  assert.equal(screen.getByLabelText('unsaved workspace input'), input);
  assert.equal(input.value, 'unsaved local draft');
  assert.deepEqual(requestedPaths.slice(bootstrapRequests).filter(path => path.startsWith('/api/auth/')), []);
});

test('signing out after a token rotation still shows the login screen without a loading pass', async () => {
  await signIn(makeToken(nowSeconds()));
  let logout: (() => void) | null = null;
  function LogoutProbe() {
    const { logout: authLogout } = useAuth();
    useEffect(() => { logout = authLogout; }, [authLogout]);
    return null;
  }
  render(<AuthProvider><LogoutProbe /><Gate /></AuthProvider>);
  await screen.findByText('workspace');
  await act(async () => { await rotate(makeToken(nowSeconds() + 1)); });
  await act(async () => { logout?.(); await synchronizeAuthSession(); });
  await screen.findByText('login');
  assert.equal(getAuthSessionSnapshot().token, null);
  assert.equal(seenToken, null);
  assert.equal(loadingPasses, 1);
});

test('a language change after sign-in does not re-run the auth bootstrap', async () => {
  await signIn(makeToken(nowSeconds()));
  renderApp();
  await screen.findByText('workspace');
  const bootstrapRequests = requestedPaths.length;
  await act(async () => { await i18n.changeLanguage('de'); });
  assert.equal(i18n.language, 'de');
  assert.equal(workspaceMounts, 1);
  assert.equal(loadingPasses, 1);
  assert.deepEqual(requestedPaths.slice(bootstrapRequests).filter(path => path.startsWith('/api/auth/')), []);
});

test('signing in before onboarding shows onboarding without mounting the workspace first', async () => {
  hasCompletedOnboarding = false;
  // Give React a real pending onboarding check: publishing the profile first must not flash the workspace.
  onboardingStatusDelayMs = 30;
  let login: ReturnType<typeof useAuth>['login'] | null = null;
  function LoginProbe() {
    const { login: authLogin } = useAuth();
    useEffect(() => { login = authLogin; }, [authLogin]);
    return null;
  }
  render(<AuthProvider><LoginProbe /><Gate /></AuthProvider>);
  await screen.findByText('login');
  let pendingLogin: Promise<unknown> | undefined;
  act(() => { pendingLogin = login?.('triage', 'triage-pass-123'); });
  await screen.findByText('onboarding');
  await act(async () => { await pendingLogin; });
  assert.ok(requestedPaths.includes('/api/user/onboarding-status'));
  assert.notEqual(getAuthSessionSnapshot().token, null);
  assert.equal(workspaceMounts, 0);
});

test('the scheduled half-life refresh uses the real API without remounting or replacing input', async () => {
  await signIn(makeToken(nowSeconds()));
  renderApp();
  await screen.findByText('workspace');
  const input = screen.getByLabelText('unsaved workspace input') as HTMLInputElement;
  input.value = 'keep scheduled-refresh draft';
  const initial = getAuthSessionSnapshot();
  const bootstrapChecks = requestedPaths.filter(path => path === '/api/auth/user').length;
  vi.useFakeTimers();
  const nearlyDue = makeToken(nowSeconds() - 3.5 * 86400 + 60);
  refreshToken = makeToken(nowSeconds() + 1);
  await act(async () => { await rotate(nearlyDue); });
  const delay = getAuthTokenRefreshDelay(nearlyDue);
  assert.ok(delay !== null && delay > 0);
  await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
  assert.equal(requestedPaths.filter(path => path === '/api/auth/refresh').length, 0);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  assert.equal(requestedPaths.filter(path => path === '/api/auth/refresh').length, 1);
  assert.equal(getAuthSessionSnapshot().token, refreshToken);
  assert.equal(getAuthSessionSnapshot().sessionInstanceId, initial.sessionInstanceId);
  assert.equal(requestedPaths.filter(path => path === '/api/auth/user').length, bootstrapChecks);
  assert.equal(workspaceMounts, 1);
  assert.equal(loadingPasses, 1);
  assert.equal(screen.getByLabelText('unsaved workspace input'), input);
  assert.equal(input.value, 'keep scheduled-refresh draft');
});
