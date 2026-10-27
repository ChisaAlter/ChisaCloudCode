import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AccountServerConnection } from '@/modules/auth/AccountServerConnection';
import LoginForm from '@/modules/auth/LoginForm';
import { SignedOutDesktop } from '@/modules/auth/SignedOutDesktop';

const native = vi.hoisted(() => ({ desktop: true, getState: vi.fn(), getApiConnection: vi.fn(), connectServer: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null, login: vi.fn(), logout: vi.fn(), error: null }));
vi.mock('@/shared/chisa', () => ({ isDesktop: () => native.desktop, FrontendBridge: native }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/modules/auth/AccountMenu', () => ({ AccountMenu: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(() => {
  vi.resetAllMocks();
  native.desktop = true;
  native.getState.mockResolvedValue({ serverUrl: 'https://saved.example' });
  native.getApiConnection.mockResolvedValue({ configured: true });
  native.connectServer.mockResolvedValue({ ok: true, serverUrl: 'https://new.example' });
  auth.login.mockResolvedValue({ success: true });
});
afterEach(() => cleanup());

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
  render(<LoginForm embedded />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  native.connectServer.mockResolvedValueOnce({ ok: true, serverUrl: 'https://saved.example' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.equal(loginButton().disabled, false);
  native.connectServer.mockClear();
  enterCredentials();
  fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: 'https://new.example/' } });
  assert.equal(loginButton().disabled, true);
  fireEvent.submit(screen.getByLabelText('login.username').closest('form')!);
  assert.equal(auth.login.mock.calls.length, 0);

  native.connectServer.mockResolvedValueOnce({ ok: false, error: '服务器不可达' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.ok(screen.getByText('服务器不可达'));
  assert.equal(loginButton().disabled, true);
  assert.equal(auth.logout.mock.calls.length, 0);

  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.deepEqual(native.connectServer.mock.calls, [['https://new.example/'], ['https://new.example/']]);
  assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://new.example');
  assert.equal(auth.logout.mock.calls.length, 1);
  assert.equal(loginButton().disabled, false);
  await act(async () => { fireEvent.click(loginButton()); });
  assert.deepEqual(auth.login.mock.calls, [['alice', 'example-password']]);
});

test('a fresh desktop requires a connection and a same-server reconnect keeps the current session', async () => {
  native.getApiConnection.mockResolvedValue({ configured: false });
  native.connectServer.mockResolvedValue({ ok: true, serverUrl: 'https://saved.example' });
  render(<LoginForm embedded />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  assert.equal(loginButton().disabled, true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.equal(loginButton().disabled, false);
  assert.equal(auth.logout.mock.calls.length, 0);
});

test('switching in a second connection form updates and blocks the main login until reconnection', async () => {
  const view = render(<><LoginForm embedded /><AccountServerConnection /></>);
  await waitFor(() => assert.equal((screen.getAllByLabelText('服务器地址')[1] as HTMLInputElement).value, 'https://saved.example'));
  native.connectServer.mockResolvedValueOnce({ ok: true, serverUrl: 'https://saved.example' });
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
  native.desktop = false;
  render(<LoginForm embedded />);
  assert.equal(screen.queryByLabelText('服务器地址'), null);
  enterCredentials();
  await act(async () => { fireEvent.click(loginButton()); });
  assert.equal(native.getState.mock.calls.length, 0);
  assert.deepEqual(auth.login.mock.calls, [['alice', 'example-password']]);
});
