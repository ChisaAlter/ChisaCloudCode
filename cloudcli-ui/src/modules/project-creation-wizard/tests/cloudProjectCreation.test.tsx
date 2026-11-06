import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ProjectCreationWizard } from '@/modules/project-creation-wizard';
import { api } from '@/shared/api';
import { acknowledgeAuthSession, clearAuthToken, getAuthSessionSnapshot, initializeAuthSession, startAuthSession } from '@/shared/authToken';
import { FrontendBridge } from '@/shared/chisa';
import type { ChisaApiConnection } from '@/shared/types';
import { getBlockingOperations } from '@/shared/utils';

const native = vi.hoisted(() => {
  // Native authority is selected at module startup, just as in the actual desktop renderer.
  vi.stubGlobal('mygo', {});
  return { call: vi.fn() };
});
vi.mock('mygo-runtime', () => ({ call: native.call }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubGlobal('mygo', {});
  localStorage.clear();
  sessionStorage.clear();
  await initializeAuthSession();
  native.call.mockResolvedValueOnce(nativeConnection('https://original-server.example', 1));
  await FrontendBridge.getApiConnection();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function accountToken(userId: string): string {
  const payload = btoa(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + 600 })).replace(/=/g, '');
  return `header.${payload}.signature`;
}
function nativeConnection(serverKey: string, generation: number): ChisaApiConnection {
  return { protocolVersion: 2, configured: true, sessionHandle: `cloud-import-session-${generation}`,
    generation, version: generation, tokenRevision: 0, authenticated: false, serverKey,
    accessToken: '', restorationToken: '', switching: false,
    httpProxyUrl: `http://127.0.0.1:18792/channel/import-${generation}`,
    webSocketUrl: `ws://127.0.0.1:18792/channel/import-${generation}` };
}

test('folder browsing selects a server directory and keeps local folder selection absent', async () => {
  const browse = vi.spyOn(api, 'browseFilesystem').mockResolvedValue(Response.json({ path: '/cloud', suggestions: [{ path: '/cloud/existing', name: 'existing' }] }));
  const create = vi.spyOn(api, 'createProject').mockResolvedValue(Response.json({ project: { projectId: 'existing', fullPath: '/cloud/existing' } }));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  fireEvent.click(screen.getByTitle('common:misc.browseFolders'));
  await screen.findByText('existing');
  expect(browse).toHaveBeenCalledExactlyOnceWith('~');
  expect(screen.queryByRole('button', { name: '本机' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'folderBrowser.select' }));
  expect((screen.getByPlaceholderText('/path/to/project/workspace') as HTMLInputElement).value).toBe('/cloud/existing');
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith({ projectId: 'existing', fullPath: '/cloud/existing' }));
  expect(create).toHaveBeenCalledExactlyOnceWith({ path: '/cloud/existing' });
});

const running = { jobId: 'cloud-job', status: 'running', message: 'Receiving cloud objects 50%' };
const project = { projectId: 'imported', fullPath: '/cloud/imported' };
const complete = { ...running, status: 'complete', message: 'Import complete', project };
async function reviewImport() {
  fireEvent.change(screen.getByPlaceholderText('/path/to/project/workspace'), { target: { value: '/cloud/imported' } });
  fireEvent.change(screen.getByPlaceholderText('https://github.com/username/repository'), { target: { value: 'https://github.com/example/project' } });
  await waitFor(() => expect(api.settings.credentials).toHaveBeenCalledWith('github_token'));
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.next' }));
}
function credentials() { vi.spyOn(api.settings, 'credentials').mockResolvedValue(Response.json({ credentials: [] })); }

test('cloud Git import polls authenticated task progress and opens the returned project', async () => {
  credentials();
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  vi.spyOn(api, 'getCloneJob').mockResolvedValue(Response.json(complete));
  const opened = vi.fn();
  const close = vi.fn();
  render(<ProjectCreationWizard onClose={close} onProjectCreated={opened} />);
  await reviewImport();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await screen.findByText(running.message);
  expect(start.mock.calls[0][0]).toEqual({ path: '/cloud/imported', githubUrl: 'https://github.com/example/project', requestId: expect.any(String) });
  await waitFor(() => expect(opened).toHaveBeenCalledExactlyOnceWith(project));
  expect(close).toHaveBeenCalledOnce();
});

test('failed observation resumes the same job and rapid submit cannot create another task', async () => {
  credentials();
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  const get = vi.spyOn(api, 'getCloneJob').mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(Response.json(complete));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  await reviewImport();
  const submit = screen.getByRole('button', { name: 'projectWizard.buttons.createProject' });
  act(() => { fireEvent.click(submit); fireEvent.click(submit); });
  await screen.findByText(/Import status is unknown/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry import / open project' }));
  await waitFor(() => expect(opened).toHaveBeenCalledWith(project));
  expect(start).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledTimes(2);
});

test('completed clone with a failed project opening retries opening without cloning again', async () => {
  credentials();
  const start = vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(complete));
  const get = vi.spyOn(api, 'getCloneJob');
  const opened = vi.fn().mockRejectedValueOnce(new Error('List refresh failed')).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<ProjectCreationWizard onClose={close} onProjectCreated={opened} />);
  await reviewImport();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await screen.findByText(/Import completed, but opening the project or refreshing the project list failed/);
  fireEvent.click(screen.getByRole('button', { name: 'Retry import / open project' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(opened).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
});

test('cancel remains reachable during import and sends DELETE for the accepted job', async () => {
  credentials();
  vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  const get = vi.spyOn(api, 'getCloneJob');
  const cancel = vi.spyOn(api, 'cancelCloneJob').mockResolvedValue(Response.json({ ...running, status: 'cancelled', message: 'Cancelled' }));
  const opened = vi.fn();
  render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  await reviewImport();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await screen.findByText(running.message);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
  await screen.findByText('Import cancelled.');
  expect(cancel).toHaveBeenCalledExactlyOnceWith('cloud-job');
  expect(get).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  expect(getBlockingOperations()).toEqual([]);
});

test.each(['unmount', 'account', 'server'] as const)('cleanup suppresses stale callbacks and only cancels matching identity: %s', async transition => {
  credentials();
  vi.spyOn(api, 'startCloneJob').mockResolvedValue(Response.json(running));
  let resolvePoll!: (value: Response) => void;
  const get = vi.spyOn(api, 'getCloneJob').mockImplementation(() => new Promise(resolve => { resolvePoll = resolve; }));
  const cancel = vi.spyOn(api, 'cancelCloneJob').mockResolvedValue(Response.json({ ...running, status: 'cancelled', message: 'Cancelled' }));
  const opened = vi.fn();
  const view = render(<ProjectCreationWizard onClose={vi.fn()} onProjectCreated={opened} />);
  await reviewImport();
  fireEvent.click(screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }));
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
  const captured = getAuthSessionSnapshot();
  if (transition === 'unmount') view.unmount();
  else if (transition === 'account') {
    await clearAuthToken(captured);
    const replacement = await startAuthSession(accountToken('replacement-owner'), getAuthSessionSnapshot());
    expect(replacement).not.toBeNull();
    acknowledgeAuthSession(replacement!);
    expect(getAuthSessionSnapshot()).toMatchObject({ phase: 'ready', userId: 'replacement-owner' });
    expect(getAuthSessionSnapshot().sessionInstanceId).not.toBe(captured.sessionInstanceId);
  } else {
    const connection = nativeConnection('https://different-server.example', 2);
    native.call.mockResolvedValueOnce({ ok: true, changed: true, serverUrl: connection.serverKey, connection });
    await FrontendBridge.connectServer(connection.serverKey);
    // A server transition must commit the native authority, not merely bump a legacy transport counter.
    expect(getAuthSessionSnapshot()).toMatchObject({ serverKey: connection.serverKey,
      sessionInstanceId: connection.sessionHandle, nativeHandle: connection.sessionHandle, phase: 'signedOut' });
    expect(getAuthSessionSnapshot().sessionInstanceId).not.toBe(captured.sessionInstanceId);
  }
  if (transition !== 'unmount') {
    await screen.findByText(/Account or server changed/);
    expect((screen.getByRole('button', { name: 'projectWizard.buttons.createProject' }) as HTMLButtonElement).disabled).toBe(false);
  }
  await act(async () => { resolvePoll(Response.json(complete)); });
  expect(opened).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(transition === 'unmount' ? 1 : 0);
  expect(getBlockingOperations()).toEqual([]);
});
