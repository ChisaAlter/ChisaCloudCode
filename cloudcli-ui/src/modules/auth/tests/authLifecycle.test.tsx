import assert from 'node:assert/strict';
import { useEffect } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { storeAuthToken } from '@/shared/authToken';

const requests = vi.hoisted(() => ({ user: vi.fn(), updateProfile: vi.fn(), login: vi.fn(), refresh: vi.fn(), onboardingStatus: vi.fn() }));
vi.mock('@/shared/api', () => ({ ServiceConnectionError: class extends Error {}, api: { auth: requests, user: { onboardingStatus: requests.onboardingStatus } } }));
vi.mock('@/shared/chatDrafts', () => ({ hydrateChatDrafts: vi.fn(), resetChatDrafts: vi.fn() }));
vi.mock('@/shared/userSettings', () => ({ hydrateUserPreferences: vi.fn(), resetUserPreferences: vi.fn() }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => false }));
vi.mock('@/modules/onboarding', () => ({ Onboarding: () => <p>onboarding</p> }));
vi.mock('@/modules/auth/AuthLoadingScreen', () => ({ default: () => <p>loading account</p> }));
vi.mock('@/modules/auth/LoginForm', () => ({ default: () => <p>signed out</p> }));
vi.mock('@/modules/auth/SignedOutDesktop', () => ({ SignedOutDesktop: () => <p>desktop signed out</p> }));
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
let auth!: ReturnType<typeof useAuth>;
let mounts = 0;
function AccountProbe() {
  const account = useAuth();
  useEffect(() => { auth = account; }, [account]);
  return <p>{account.user?.displayName || account.user?.username || 'no account'}</p>;
}
function WorkspaceProbe() { useEffect(() => { mounts += 1; }, []); return <input aria-label="workspace buffer" defaultValue="original" />; }
async function mount() {
  render(<AuthProvider><AccountProbe /><ProtectedRoute><WorkspaceProbe /></ProtectedRoute></AuthProvider>);
  await waitFor(() => assert.ok(screen.getByLabelText('workspace buffer')));
}
beforeEach(() => {
  vi.resetAllMocks(); mounts = 0; localStorage.clear();
  localStorage.setItem('auth-token', 'initial.payload.signature');
  requests.user.mockImplementation(() => Promise.resolve(json({ user: { id: 1, username: 'demo-user' } })));
  requests.onboardingStatus.mockImplementation(() => Promise.resolve(json({ hasCompletedOnboarding: true })));
});
afterEach(() => cleanup());

test('JWT rotation retains the workspace and unsaved input while its account check waits', async () => {
  await mount();
  const input = screen.getByLabelText('workspace buffer') as HTMLInputElement;
  input.value = 'unsaved local draft';
  const checked = deferred<Response>();
  requests.user.mockReturnValue(checked.promise);
  act(() => { storeAuthToken('rotated.payload.signature'); });
  await waitFor(() => assert.equal(requests.user.mock.calls.length, 2));
  assert.equal(screen.queryByText('loading account'), null);
  assert.equal(screen.getByLabelText('workspace buffer'), input);
  assert.equal(input.value, 'unsaved local draft');
  await act(async () => { checked.resolve(json({ user: { id: 1, username: 'demo-user' } })); });
  assert.equal(mounts, 1);
});

test('logout rejects a late profile save and a late auth check without reviving the account', async () => {
  await mount();
  const profile = deferred<Response>();
  const checked = deferred<Response>();
  requests.updateProfile.mockReturnValue(profile.promise);
  requests.user.mockReturnValue(checked.promise);
  let update!: ReturnType<typeof auth.updateProfile>;
  let checking!: Promise<void>;
  act(() => { update = auth.updateProfile('new name', null); checking = auth.refreshAuthStatus(); });
  act(() => auth.logout());
  await act(async () => {
    profile.resolve(json({ user: { id: 1, username: 'demo-user', displayName: 'old saved response' } }));
    checked.resolve(json({ user: { id: 1, username: 'demo-user' } }));
    const result = await update;
    assert.equal(result.success, false);
    await checking;
  });
  assert.equal(auth.user, null);
  assert.equal(auth.isLoading, false);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.ok(screen.getByText('signed out'));
});

test('an initial 502 preserves the stored session and manual account refresh can recover it', async () => {
  requests.user.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }));
  render(<AuthProvider><AccountProbe /><ProtectedRoute><WorkspaceProbe /></ProtectedRoute></AuthProvider>);
  await waitFor(() => assert.equal(auth.isLoading, false));

  assert.equal(localStorage.getItem('auth-token'), 'initial.payload.signature');
  assert.equal(auth.token, 'initial.payload.signature');
  assert.equal(auth.user, null);
  assert.ok(auth.error);
  assert.equal(screen.queryByText('loading account'), null);
  assert.equal(mounts, 0);

  await act(async () => { await auth.refreshAuthStatus(); });

  assert.ok(screen.getByText('demo-user'));
  assert.equal(auth.error, null);
  assert.equal(localStorage.getItem('auth-token'), 'initial.payload.signature');
  assert.ok(screen.getByLabelText('workspace buffer'));
  assert.equal(mounts, 1);
});

test('a 503 account check retains the mounted workspace and its unsaved input', async () => {
  await mount();
  const input = screen.getByLabelText('workspace buffer') as HTMLInputElement;
  input.value = 'unsaved workspace content';
  requests.user.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }));

  await act(async () => { await auth.refreshAuthStatus(); });

  assert.equal(auth.user?.username, 'demo-user');
  assert.equal(auth.token, 'initial.payload.signature');
  assert.equal(localStorage.getItem('auth-token'), 'initial.payload.signature');
  assert.ok(auth.error);
  assert.equal(auth.isLoading, false);
  assert.equal(screen.getByLabelText('workspace buffer'), input);
  assert.equal(input.value, 'unsaved workspace content');
  assert.equal(screen.queryByText('signed out'), null);
  assert.equal(mounts, 1);
});

test.each([401, 403])('a %s account response clears the stored session and removes the protected workspace', async status => {
  await mount();
  requests.user.mockResolvedValueOnce(new Response('Account access denied', { status }));

  await act(async () => { await auth.refreshAuthStatus(); });

  assert.equal(auth.user, null);
  assert.equal(auth.token, null);
  assert.equal(auth.isLoading, false);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(screen.queryByLabelText('workspace buffer'), null);
  assert.ok(screen.getByText('signed out'));
});
