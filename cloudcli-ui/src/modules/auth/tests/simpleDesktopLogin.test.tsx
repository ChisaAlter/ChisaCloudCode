import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import LoginForm from '@/modules/auth/LoginForm';
import ProtectedRoute from '@/modules/auth/ProtectedRoute';

const translate = vi.hoisted(() => (key: string) => key);
const mode = vi.hoisted(() => ({ desktop: true }));
const account = vi.hoisted(() => ({
  user: null as null | { id: number; username: string },
  isLoading: false,
  hasCompletedOnboarding: false,
  error: null,
  login: vi.fn(),
  refreshOnboardingStatus: vi.fn(),
}));
const native = vi.hoisted(() => ({ getState: vi.fn(), connectServer: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('@/modules/auth/context/AuthContext', () => ({ useAuth: () => account }));
vi.mock('@/shared/chisa', () => ({ FrontendBridge: native, isDesktop: () => mode.desktop }));
vi.mock('@/shared/utils', () => ({ IS_PLATFORM: false }));
vi.mock('@/modules/onboarding', () => ({ Onboarding: () => <p>optional server setup</p> }));
vi.mock('@/modules/auth/SignedOutDesktop', () => ({ SignedOutDesktop: () => <p>desktop signed out</p> }));
vi.mock('@/modules/auth/AuthLoadingScreen', () => ({ default: () => <p>account loading</p> }));

beforeEach(() => {
  vi.resetAllMocks();
  mode.desktop = true;
  account.user = null;
  account.isLoading = false;
  account.hasCompletedOnboarding = false;
  native.getState.mockResolvedValue({ serverUrl: 'https://saved.example' });
  native.connectServer.mockResolvedValue({ ok: true, serverUrl: 'https://saved.example' });
  account.login.mockResolvedValue({ success: true });
});
afterEach(cleanup);

async function mountLogin() {
  const view = render(<LoginForm embedded />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'login.submit' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText('login.username'), { target: { value: ' qa-user ' } });
  fireEvent.change(screen.getByLabelText('login.password'), { target: { value: 'password-with-spaces ' } });
  return view;
}

test('desktop login has exactly a prefilled address, account and password and connects before signing in', async () => {
  const view = await mountLogin();
  expect(view.container.querySelectorAll('input').length).toBe(3);
  const address = screen.getByLabelText('login.serverAddress') as HTMLInputElement;
  expect(address.value).toBe('https://saved.example');
  expect(address.type).toBe('url');
  expect(screen.queryByText(/SSH|private key|sync address/i)).toBeNull();
  fireEvent.change(address, { target: { value: ' https://chosen.example ' } });
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(account.login).toHaveBeenCalledWith('qa-user', 'password-with-spaces '));
  expect(native.connectServer).toHaveBeenCalledWith('https://chosen.example');
  expect(native.connectServer.mock.invocationCallOrder[0]).toBeLessThan(account.login.mock.invocationCallOrder[0]);
});

test('connection failure stays in the login form and never sends credentials', async () => {
  native.connectServer.mockResolvedValue({ ok: false, error: 'Service is unavailable' });
  const view = await mountLogin();
  fireEvent.submit(view.container.querySelector('form')!);
  expect((await screen.findByRole('alert')).textContent).toBe('Service is unavailable');
  expect(account.login).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'login.submit' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByLabelText('login.password') as HTMLInputElement).value).toBe('password-with-spaces ');
});

test('the single login action and all three inputs wait while the service connects', async () => {
  let finish!: (value: Record<string, unknown>) => void;
  native.connectServer.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = await mountLogin();
  fireEvent.submit(view.container.querySelector('form')!);
  const button = await screen.findByRole('button', { name: 'login.loading' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect([...view.container.querySelectorAll('input')].every(input => input.disabled)).toBe(true);
  expect(account.login).not.toHaveBeenCalled();
  await act(async () => { finish({ ok: true }); });
  expect(account.login).toHaveBeenCalledTimes(1);
  expect((screen.getByRole('button', { name: 'login.submit' }) as HTMLButtonElement).disabled).toBe(false);
});

test('failure to read the saved service address lets the user enter one without another setup screen', async () => {
  native.getState.mockRejectedValue(new Error('Native state unavailable'));
  const view = await mountLogin();
  expect(screen.getByRole('alert').textContent).toBe('login.errors.serverAddressRead');
  fireEvent.change(screen.getByLabelText('login.serverAddress'), { target: { value: 'https://manual.example' } });
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(account.login).toHaveBeenCalledTimes(1));
  expect(native.connectServer).toHaveBeenCalledWith('https://manual.example');
});

test('a rejected native connection restores the login action without calling account authentication', async () => {
  native.connectServer.mockRejectedValue(new Error('Native connection failed'));
  const view = await mountLogin();
  fireEvent.submit(view.container.querySelector('form')!);
  expect((await screen.findByRole('alert')).textContent).toBe('Native connection failed');
  expect(account.login).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'login.submit' }) as HTMLButtonElement).disabled).toBe(false);
});

test('web login keeps only its original credential fields and does not use the native bridge', async () => {
  mode.desktop = false;
  const view = await mountLogin();
  expect(view.container.querySelectorAll('input').length).toBe(2);
  expect(screen.queryByLabelText('login.serverAddress')).toBeNull();
  fireEvent.submit(view.container.querySelector('form')!);
  await waitFor(() => expect(account.login).toHaveBeenCalledTimes(1));
  expect(native.getState).not.toHaveBeenCalled();
  expect(native.connectServer).not.toHaveBeenCalled();
});

test('a signed-in desktop account enters its workspace without mandatory Git or agent setup', () => {
  account.user = { id: 1, username: 'qa-user' };
  render(<ProtectedRoute><p>workspace ready</p></ProtectedRoute>);
  expect(screen.getByText('workspace ready')).toBeDefined();
  expect(screen.queryByText('optional server setup')).toBeNull();
  expect(account.refreshOnboardingStatus).not.toHaveBeenCalled();
});

test('web accounts still follow their existing setup gate', () => {
  mode.desktop = false;
  account.user = { id: 1, username: 'qa-user' };
  render(<ProtectedRoute><p>workspace ready</p></ProtectedRoute>);
  expect(screen.getByText('optional server setup')).toBeDefined();
  expect(screen.queryByText('workspace ready')).toBeNull();
});

test('removing desktop setup does not let a signed-out account enter a workspace', () => {
  render(<ProtectedRoute><p>workspace ready</p></ProtectedRoute>);
  expect(screen.getByText('desktop signed out')).toBeDefined();
  expect(screen.queryByText('workspace ready')).toBeNull();
});
