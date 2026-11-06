import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { AccountServerConnection as ConnectionForm } from '@/modules/auth/AccountServerConnection';
import type LoginComponent from '@/modules/auth/LoginForm';
import type { SignedOutDesktop as DesktopEntry } from '@/modules/auth/SignedOutDesktop';
import type * as AuthTokenModule from '@/shared/authToken';
import type * as ChisaModule from '@/shared/chisa';
import type { ChisaApiConnection } from '@/shared/types';

const native = vi.hoisted(() => ({ call: vi.fn(), getState: vi.fn(), getApiConnection: vi.fn(), connectServer: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null, login: vi.fn(), logout: vi.fn(), error: null }));
vi.mock('mygo-runtime', () => ({ call: native.call }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/modules/auth/AccountMenu', () => ({ AccountMenu: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Load the real bridge and authority only after the desktop host is installed for each case.
let session: typeof AuthTokenModule;
let bridge: typeof ChisaModule;
let LoginForm: typeof LoginComponent;
let AccountServerConnection: typeof ConnectionForm;
let SignedOutDesktop: typeof DesktopEntry;
// The native peer owns the committed target; connection replies must carry its v2 handshake.
let connection: ChisaApiConnection;

function nativeConnection(serverUrl = 'https://saved.example', generation = 1): ChisaApiConnection {
  return {
    protocolVersion: 2, configured: true, sessionHandle: `desktop-login-session-${generation}`,
    generation, version: generation, tokenRevision: 0, authenticated: false, serverKey: serverUrl,
    accessToken: '', restorationToken: '', switching: false,
    httpProxyUrl: `http://127.0.0.1:18792/channel/login-${generation}`,
    webSocketUrl: `ws://127.0.0.1:18792/channel/login-${generation}`,
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('mygo', {});
  localStorage.clear();
  sessionStorage.clear();
  connection = nativeConnection();
  native.getState.mockResolvedValue({ serverUrl: 'https://saved.example' });
  native.getApiConnection.mockImplementation(async () => ({ ...connection }));
  native.connectServer.mockImplementation(async (address: string) => {
    const serverUrl = address.replace(/\/$/, '');
    const changed = serverUrl !== connection.serverKey || !connection.configured;
    if (changed) connection = nativeConnection(serverUrl, connection.generation + 1);
    return { ok: true, changed, serverUrl, connection: { ...connection } };
  });
  native.call.mockImplementation((method: string, ...args: unknown[]) => {
    if (method === 'FrontendBridge.GetState') return native.getState(...args);
    if (method === 'FrontendBridge.GetApiConnection') return native.getApiConnection(...args);
    if (method === 'FrontendBridge.ConnectServer') return native.connectServer(...args);
    throw new Error(`Unexpected native method: ${method}`);
  });
  auth.login.mockResolvedValue({ success: true });
  session = await import('@/shared/authToken');
  await session.initializeAuthSession();
  bridge = await import('@/shared/chisa');
  LoginForm = (await import('@/modules/auth/LoginForm')).default;
  ({ AccountServerConnection } = await import('@/modules/auth/AccountServerConnection'));
  ({ SignedOutDesktop } = await import('@/modules/auth/SignedOutDesktop'));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const loginButton = () => screen.getByRole('button', { name: 'login.submit' }) as HTMLButtonElement;

function enterCredentials() {
  fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'example-password' } });
}

test('the signed-out desktop shows the saved server address and credentials without opening a menu', async () => {
  render(<SignedOutDesktop />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  assert.ok(screen.getByLabelText('login.username'));
  assert.ok(screen.getByLabelText('login.password'));
  assert.ok(screen.getByRole('button', { name: '连接服务器' }));
  assert.equal(loginButton().disabled, true);
});

test('editing the address blocks credentials until the new server successfully connects', async () => {
  await bridge.FrontendBridge.getApiConnection();
  const originalSession = session.getAuthSessionSnapshot();
  render(<LoginForm embedded />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.equal(loginButton().disabled, false);
  assert.deepEqual(session.getAuthSessionSnapshot(), originalSession);
  native.connectServer.mockClear();
  enterCredentials();
  fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: 'https://new.example/' } });
  assert.equal(loginButton().disabled, true);
  fireEvent.submit(screen.getByLabelText('login.username').closest('form')!);
  assert.equal(auth.login.mock.calls.length, 0);

  native.connectServer.mockResolvedValueOnce({ ok: false, error: '服务器不可达', connection: { ...connection } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.ok(screen.getByText('服务器不可达'));
  assert.equal(loginButton().disabled, true);
  assert.equal(auth.logout.mock.calls.length, 0);
  assert.deepEqual(session.getAuthSessionSnapshot(), originalSession);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.deepEqual(native.connectServer.mock.calls, [['https://new.example/'], ['https://new.example/']]);
  assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://new.example');
  // Native ConnectServer commits the target and signed-out identity; a second UI logout could revoke the wrong session.
  assert.equal(auth.logout.mock.calls.length, 0);
  const changedSession = session.getAuthSessionSnapshot();
  assert.notEqual(changedSession.sessionInstanceId, originalSession.sessionInstanceId);
  assert.equal(changedSession.nativeHandle, connection.sessionHandle);
  assert.equal(changedSession.serverKey, 'https://new.example');
  assert.equal(changedSession.phase, 'signedOut');
  assert.equal(changedSession.token, null);
  assert.equal(loginButton().disabled, false);
  await act(async () => { fireEvent.click(loginButton()); });
  assert.deepEqual(auth.login.mock.calls, [['alice', 'example-password']]);
});

test('a fresh desktop requires a connection and a same-server reconnect keeps the current session', async () => {
  connection = { ...nativeConnection(), configured: false };
  await bridge.FrontendBridge.getApiConnection();
  render(<LoginForm embedded />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  assert.equal(loginButton().disabled, true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.equal(loginButton().disabled, false);
  assert.equal(auth.logout.mock.calls.length, 0);

  // Simulate the native login handoff, then prove that a successful same-target probe keeps it exactly.
  const payload = btoa(JSON.stringify({ userId: 'alice', exp: Math.floor(Date.now() / 1000) + 600 })).replace(/=/g, '');
  connection = { ...connection, tokenRevision: 1, authenticated: true, accessToken: `header.${payload}.signature` };
  await bridge.FrontendBridge.getApiConnection();
  const signedIn = session.getAuthSessionSnapshot();
  session.acknowledgeAuthSession(signedIn);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.deepEqual(session.getAuthSessionSnapshot(), signedIn);
  assert.equal(session.getAuthSessionSnapshot().phase, 'ready');
  assert.equal(session.getAuthSessionSnapshot().userId, 'alice');
  assert.equal(loginButton().disabled, false);
  assert.equal(auth.logout.mock.calls.length, 0);
});

test('switching in a second connection form updates and blocks the main login until reconnection', async () => {
  const view = render(<><LoginForm embedded /><AccountServerConnection /></>);
  await waitFor(() => assert.equal((screen.getAllByLabelText('服务器地址')[1] as HTMLInputElement).value, 'https://saved.example'));
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '连接服务器' })[0]); });
  assert.equal(loginButton().disabled, false);
  fireEvent.change(screen.getAllByLabelText('服务器地址')[1], { target: { value: 'https://new.example' } });
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '连接服务器' })[1]); });
  assert.equal((screen.getAllByLabelText('服务器地址')[0] as HTMLInputElement).value, 'https://new.example');
  assert.equal(loginButton().disabled, true);
  view.unmount();
});

test('changing the server clears the previous login error', async () => {
  render(<LoginForm embedded />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  enterCredentials();
  auth.login.mockResolvedValueOnce({ success: false, error: 'old server rejected login' });
  await act(async () => { fireEvent.click(loginButton()); });
  assert.ok(screen.getByText('old server rejected login'));
  fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: 'https://other.example' } });
  assert.equal(screen.queryByText('old server rejected login'), null);
});

test('web login continues using the current web server without a native configuration field', async () => {
  vi.stubGlobal('mygo', undefined);
  render(<LoginForm embedded />);
  assert.equal(screen.queryByLabelText('服务器地址'), null);
  enterCredentials();
  await act(async () => { fireEvent.click(loginButton()); });
  assert.equal(native.getState.mock.calls.length, 0);
  assert.deepEqual(auth.login.mock.calls, [['alice', 'example-password']]);
});
