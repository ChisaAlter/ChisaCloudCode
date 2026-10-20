import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AccountServerConnection } from '@/modules/auth/AccountServerConnection';
import LoginForm from '@/modules/auth/LoginForm';
import { SignedOutDesktop } from '@/modules/auth/SignedOutDesktop';

const native = vi.hoisted(() => ({ desktop: true, getState: vi.fn(), connectServer: vi.fn() }));
const auth = vi.hoisted(() => ({ user: null, login: vi.fn(), logout: vi.fn(), error: null }));
const translate = vi.hoisted(() => (key: string) => key);
vi.mock('@/shared/chisa', () => ({ isDesktop: () => native.desktop, FrontendBridge: native }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/modules/auth/WorkspaceConnectionForm', () => ({ WorkspaceConnectionForm: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

beforeEach(() => {
  vi.resetAllMocks();
  native.desktop = true;
  native.getState.mockResolvedValue({ serverUrl: 'https://saved.example' });
  native.connectServer.mockResolvedValue({ ok: true, serverUrl: 'https://new.example' });
  auth.login.mockResolvedValue({ success: true });
});
afterEach(cleanup);

const loginButton = () => screen.getByRole('button', { name: 'login.submit' }) as HTMLButtonElement;

function enterCredentials() {
  fireEvent.change(screen.getByLabelText('login.username'), { target: { value: 'alice' } });
  fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'example-password' } });
}

test('the new desktop layout keeps the published single-step sign-in contract', async () => {
  const view = render(<SignedOutDesktop />);
  await waitFor(() => assert.equal((screen.getByLabelText('login.serverAddress') as HTMLInputElement).value, 'https://saved.example'));
  assert.ok(view.container.querySelector('.desktop-login-card'));
  assert.equal(view.container.querySelectorAll('input').length, 3);
  assert.equal(screen.queryByRole('button', { name: '连接服务器' }), null);
  enterCredentials();
  await act(async () => { fireEvent.click(loginButton()); });
  assert.deepEqual(native.connectServer.mock.calls, [['https://saved.example']]);
  assert.deepEqual(auth.login.mock.calls, [['alice', 'example-password']]);
});

test('an independent connection form requires a successful probe and preserves the session on same-server reconnect', async () => {
  const ready = vi.fn();
  native.connectServer.mockResolvedValue({ ok: true, serverUrl: 'https://saved.example' });
  render(<AccountServerConnection onConnectionChange={ready} />);
  await waitFor(() => assert.equal((screen.getByLabelText('服务器地址') as HTMLInputElement).value, 'https://saved.example'));
  assert.deepEqual(ready.mock.calls, [[false]]);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.equal(ready.mock.calls.at(-1)?.[0], true);
  assert.equal(auth.logout.mock.calls.length, 0);
  fireEvent.change(screen.getByLabelText('服务器地址'), { target: { value: 'https://other.example' } });
  assert.equal(ready.mock.calls.at(-1)?.[0], false);
  native.connectServer.mockResolvedValueOnce({ ok: false, error: '服务器不可达' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '连接服务器' })); });
  assert.ok(screen.getByText('服务器不可达'));
  assert.equal(auth.logout.mock.calls.length, 0);
});

test('a successful address switch updates other mounted settings forms and invalidates their old probe', async () => {
  const firstReady = vi.fn();
  const secondReady = vi.fn();
  render(<><AccountServerConnection onConnectionChange={firstReady} /><AccountServerConnection onConnectionChange={secondReady} /></>);
  await waitFor(() => assert.equal((screen.getAllByLabelText('服务器地址')[1] as HTMLInputElement).value, 'https://saved.example'));
  native.connectServer.mockResolvedValueOnce({ ok: true, serverUrl: 'https://saved.example' });
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '连接服务器' })[0]); });
  assert.equal(firstReady.mock.calls.at(-1)?.[0], true);
  fireEvent.change(screen.getAllByLabelText('服务器地址')[1], { target: { value: 'https://new.example' } });
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: '连接服务器' })[1]); });
  assert.equal((screen.getAllByLabelText('服务器地址')[0] as HTMLInputElement).value, 'https://new.example');
  assert.equal(firstReady.mock.calls.at(-1)?.[0], false);
  assert.equal(secondReady.mock.calls.at(-1)?.[0], true);
  assert.equal(auth.logout.mock.calls.length, 1);
});

test('changing the server clears the previous login error before the next single-submit attempt', async () => {
  render(<LoginForm embedded />);
  await waitFor(() => assert.equal((screen.getByLabelText('login.serverAddress') as HTMLInputElement).value, 'https://saved.example'));
  enterCredentials();
  auth.login.mockResolvedValueOnce({ success: false, error: 'old server rejected login' });
  await act(async () => { fireEvent.click(loginButton()); });
  assert.ok(screen.getByText('old server rejected login'));
  fireEvent.change(screen.getByLabelText('login.serverAddress'), { target: { value: 'https://other.example' } });
  assert.equal(screen.queryByText('old server rejected login'), null);
});
