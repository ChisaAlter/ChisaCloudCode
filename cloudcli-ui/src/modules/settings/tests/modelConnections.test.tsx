import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ModelConnectionsSection } from '@/modules/settings/tabs/models-settings/ModelConnectionsSection';

const CONNECTION = { id: 'conn-1', name: 'My DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', hasApiKey: true };
const fetchMock = vi.fn<typeof fetch>();
const testI18n = i18n.cloneInstance({ lng: 'en' });

function mount() {
  return render(<I18nextProvider i18n={testI18n}><ModelConnectionsSection /></I18nextProvider>);
}

function response(connections = [CONNECTION], activeId: string | null = null) {
  return new Response(JSON.stringify({ success: true, data: { activeId, connections } }), { status: 200 });
}

function input(label: string) {
  return screen.getByLabelText<HTMLInputElement>(label, { exact: true });
}

function savedRow(name = CONNECTION.name) {
  return screen.getByText(name, { exact: true }).closest('li')!;
}

function body(index: number) {
  return JSON.parse(fetchMock.mock.calls[index][1]?.body as string);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  localStorage.setItem('auth-token', 'test-account-token');
});

afterEach(() => vi.unstubAllGlobals());

test('locks operations until authenticated loading succeeds and aborts reads on unmount', async () => {
  let resolve!: (value: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  const view = mount();
  expect(screen.getByRole('status').textContent).toContain('Loading model connections');
  expect(screen.queryByRole('button', { name: 'Save connection' })).toBeNull();
  expect(fetchMock.mock.calls[0][0]).toBe('/api/providers/claude/connections');
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer test-account-token' });
  const signal = fetchMock.mock.calls[0][1]?.signal;
  await act(async () => { resolve(response()); });
  expect(screen.getByText('Configured — not tested')).toBeTruthy();
  expect(input('API key').value).toBe('');
  expect(input('API key').type).toBe('password');
  view.unmount();
  expect(signal?.aborted).toBe(true);
});

test('failed load exposes only a generic error and a retry, and retry aborts on unmount', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'private-key-in-server-error' }), { status: 500 }));
  const view = mount();
  await screen.findByText('Could not load model connections. Retry before making changes.');
  expect(document.body.textContent).not.toContain('private-key-in-server-error');
  expect(screen.queryByRole('button', { name: 'Save connection' })).toBeNull();
  const firstSignal = fetchMock.mock.calls[0][1]?.signal;
  fetchMock.mockReturnValueOnce(new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading connections' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(firstSignal?.aborted).toBe(true);
  const retrySignal = fetchMock.mock.calls[1][1]?.signal;
  view.unmount();
  expect(retrySignal?.aborted).toBe(true);
});

test('creates a preset connection with an editable model, clears its write-only key and never persists it in the browser', async () => {
  fetchMock.mockResolvedValueOnce(response([]));
  mount();
  await screen.findByText('No custom model connections saved.');
  const persistence = vi.spyOn(Storage.prototype, 'setItem');
  fireEvent.change(screen.getByLabelText('Provider preset'), { target: { value: 'minimax' } });
  expect(input('Base URL').value).toBe('https://api.minimaxi.com/anthropic');
  expect(input('Model name').value).toBe('MiniMax-M2.5');
  fireEvent.change(input('Model name'), { target: { value: 'MiniMax-custom' } });
  fireEvent.change(input('API key'), { target: { value: 'private-create-key' } });
  fetchMock.mockResolvedValueOnce(response([{ ...CONNECTION, name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-custom' }]));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText(/Settings saved/);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/providers/claude/connections');
  expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
  expect(body(1)).toEqual({ name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-custom', apiKey: 'private-create-key' });
  expect(input('API key').value).toBe('');
  expect(document.body.textContent).not.toContain('private-create-key');
  expect(persistence).not.toHaveBeenCalled();
  persistence.mockRestore();
});

test('edits while retaining a saved key when its field is blank and ignores unexpected secret response fields', async () => {
  fetchMock.mockResolvedValueOnce(response([{ ...CONNECTION, ...{ apiKey: 'should-never-render' } }]));
  mount();
  await screen.findByText(CONNECTION.name);
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Edit' }));
  expect(input('API key').value).toBe('');
  expect(document.body.textContent).not.toContain('should-never-render');
  fireEvent.change(input('Connection name'), { target: { value: ' Renamed connection ' } });
  fetchMock.mockResolvedValueOnce(response([{ ...CONNECTION, name: 'Renamed connection' }]));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Renamed connection');
  expect(fetchMock.mock.calls[1][0]).toBe('/api/providers/claude/connections/conn-1');
  expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
  expect(body(1)).toEqual({ name: 'Renamed connection', baseUrl: CONNECTION.baseUrl, model: CONNECTION.model });
  expect(input('API key').value).toBe('');
});

test('requires key reentry when changing authentication and saves an explicit bearer choice', async () => {
  fetchMock.mockResolvedValueOnce(response());
  mount();
  await screen.findByText(CONNECTION.name);
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'auth_token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(screen.getByRole('alert').textContent).toContain('Re-enter the API key');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.change(input('API key'), { target: { value: 'bearer-fixture-key' } });
  fetchMock.mockResolvedValueOnce(response());
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText(/Settings saved/);
  expect(body(1)).toMatchObject({ authType: 'auth_token', apiKey: 'bearer-fixture-key' });
});

test('requires key reentry when changing an endpoint, then accepts a replacement key', async () => {
  fetchMock.mockResolvedValueOnce(response());
  mount();
  await screen.findByText(CONNECTION.name);
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Edit' }));
  fireEvent.change(input('Base URL'), { target: { value: 'https://gateway.example/anthropic/' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(screen.getByRole('alert').textContent).toContain('Re-enter the API key');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.change(input('API key'), { target: { value: 'new-endpoint-key' } });
  fetchMock.mockResolvedValueOnce(response([{ ...CONNECTION, baseUrl: 'https://gateway.example/anthropic' }]));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText(/Settings saved/);
  expect(body(1)).toMatchObject({ baseUrl: 'https://gateway.example/anthropic', apiKey: 'new-endpoint-key' });
  expect(input('API key').value).toBe('');
});

test.each([
  'ftp://gateway.example', 'https://user:password@gateway.example', 'https://gateway.example?token=secret',
  'https://gateway.example#fragment', 'https://gateway.example/v1', 'https://gateway.example/v1/messages/',
])('rejects unsafe or SDK-suffixed endpoint %s before sending a key', async baseUrl => {
  fetchMock.mockResolvedValueOnce(response([]));
  mount();
  await screen.findByText('No custom model connections saved.');
  fireEvent.change(input('Connection name'), { target: { value: 'Gateway' } });
  fireEvent.change(input('Base URL'), { target: { value: baseUrl } });
  fireEvent.change(input('Model name'), { target: { value: 'custom-model' } });
  fireEvent.change(input('API key'), { target: { value: 'private-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(screen.getByRole('alert').textContent).toContain('Use an HTTP(S) base URL');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('activates a connection, locks all actions while busy, and returns to default Claude', async () => {
  fetchMock.mockResolvedValueOnce(response());
  mount();
  await screen.findByText(CONNECTION.name);
  let resolve!: (value: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Activate' }));
  expect(screen.getByRole('button', { name: 'Saving…' }).closest('fieldset')?.disabled).toBe(true);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/providers/claude/connections/active');
  expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
  expect(body(1)).toEqual({ id: CONNECTION.id });
  await act(async () => { resolve(response([CONNECTION], CONNECTION.id)); });
  expect(within(savedRow()).getByText('Active')).toBeTruthy();
  fetchMock.mockResolvedValueOnce(response());
  fireEvent.click(screen.getByRole('button', { name: 'Return to default Claude' }));
  await screen.findByText(testI18n.t('settings:modelConnections.defaultActive', { defaultValue: 'Default Claude selected' }));
  expect(body(2)).toEqual({ id: null });
});

test('requires inline confirmation before deletion and consumes the refreshed list', async () => {
  fetchMock.mockResolvedValueOnce(response([CONNECTION], CONNECTION.id));
  mount();
  await screen.findByText(CONNECTION.name);
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Delete' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Keep connection' }));
  expect(screen.queryByRole('button', { name: 'Confirm delete' })).toBeNull();
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Delete' }));
  fetchMock.mockResolvedValueOnce(response([]));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
  await screen.findByText('No custom model connections saved.');
  expect(fetchMock.mock.calls[1][0]).toBe('/api/providers/claude/connections/conn-1');
  expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
  expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined();
  expect(screen.getByText(testI18n.t('settings:modelConnections.defaultActive', { defaultValue: 'Default Claude selected' }))).toBeTruthy();
});

test('renders every connection and edits only the selected entry with its escaped id', async () => {
  const second = { ...CONNECTION, id: 'conn/second', name: 'Kimi account', baseUrl: 'https://api.kimi.com/coding', model: 'kimi-for-coding' };
  fetchMock.mockResolvedValueOnce(response([CONNECTION, second]));
  mount();
  await screen.findByText(second.name);
  expect(within(screen.getByRole('list', { name: 'Saved model connections' })).getAllByRole('listitem')).toHaveLength(2);
  fireEvent.click(within(savedRow(second.name)).getByRole('button', { name: 'Edit' }));
  expect(input('Connection name').value).toBe(second.name);
  expect(input('Model name').value).toBe(second.model);
  fetchMock.mockResolvedValueOnce(response([CONNECTION, second]));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText(/Settings saved/);
  expect(fetchMock.mock.calls[1][0]).toBe('/api/providers/claude/connections/conn%2Fsecond');
  expect(body(1)).toMatchObject({ name: second.name, baseUrl: second.baseUrl, model: second.model });
});

test('requires a key on create and discards a draft key when changing presets', async () => {
  fetchMock.mockResolvedValueOnce(response([]));
  mount();
  await screen.findByText('No custom model connections saved.');
  fireEvent.change(screen.getByLabelText('Provider preset'), { target: { value: 'deepseek' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(screen.getByRole('alert').textContent).toContain('Enter a name, model without spaces, and API key.');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fireEvent.change(input('API key'), { target: { value: 'do-not-follow-provider-switch' } });
  fireEvent.change(screen.getByLabelText('Provider preset'), { target: { value: 'glm' } });
  expect(input('Base URL').value).toBe('https://open.bigmodel.cn/api/anthropic');
  expect(input('Model name').value).toBe('glm-4.7');
  expect(input('API key').value).toBe('');
  fireEvent.change(screen.getByLabelText('Provider preset'), { target: { value: 'custom' } });
  expect(input('Base URL').value).toBe('');
  expect(input('Model name').value).toBe('');
});

test('does not leak mutation failures, preserves the draft for retry, and cancel discards its key', async () => {
  fetchMock.mockResolvedValueOnce(response());
  mount();
  await screen.findByText(CONNECTION.name);
  fireEvent.click(within(savedRow()).getByRole('button', { name: 'Edit' }));
  fireEvent.change(input('API key'), { target: { value: 'retry-private-key' } });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'server echoed retry-private-key' }), { status: 400 }));
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  await screen.findByText('Could not save model connections. Check your settings and try again.');
  expect(document.body.textContent).not.toContain('retry-private-key');
  expect(input('API key').value).toBe('retry-private-key');
  expect(screen.getByRole('button', { name: 'Save connection' }).closest('fieldset')?.disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel edit' }));
  expect(input('API key').value).toBe('');
});
