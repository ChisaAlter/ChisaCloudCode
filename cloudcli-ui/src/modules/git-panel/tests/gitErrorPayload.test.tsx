import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import GitRepositoryErrorState from '@/modules/git-panel/GitRepositoryErrorState';
import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import type { Project } from '@/shared/types';

const calls = vi.hoisted(() => ({ status: vi.fn(), branches: vi.fn(), remoteStatus: vi.fn(), checkout: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { git: calls } }));
vi.mock('@/modules/git-panel/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const project: Project = { projectId: 'a', fullPath: '/a', displayName: 'A' };
const diagnostics = { operation: 'sync_begin', timedOut: true, transportCode: 'UND_ERR_HEADERS_TIMEOUT', errorName: 'TimeoutError', elapsedMs: 300_000 };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
async function settle() { await act(async () => {}); }

beforeEach(() => {
  vi.resetAllMocks();
  calls.status.mockImplementation(async () => response({ branch: 'main' }));
  calls.branches.mockImplementation(async () => response({ branches: ['main'] }));
  calls.remoteStatus.mockImplementation(async () => response({ hasRemote: false }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

test.each([
  { name: 'transport diagnostics', payload: { error: 'Workspace synchronization timed out', details: diagnostics }, error: 'Workspace synchronization timed out', details: undefined },
  { name: 'legacy text', payload: { error: 'Git status unavailable', details: 'Reconnect the desktop app.' }, error: 'Git status unavailable', details: 'Reconnect the desktop app.' },
  { name: 'structured error', payload: { success: false, error: { code: 'WORKSPACE_BUSY', message: 'Workspace is busy', details: diagnostics } }, error: 'Workspace is busy', details: undefined },
  { name: 'structured text details', payload: { error: { message: 'Workspace is busy', details: 'Wait for the running task.' } }, error: 'Workspace is busy', details: 'Wait for the running task.' },
  { name: 'detail message', payload: { error: 'Git status unavailable', details: { message: 'Reconnect the desktop app.', ...diagnostics } }, error: 'Git status unavailable', details: 'Reconnect the desktop app.' },
  { name: 'unknown error object', payload: { error: { code: 'UNAVAILABLE' }, details: diagnostics }, error: 'Git request failed (HTTP 503)', details: undefined },
  { name: 'serialized diagnostics', payload: { error: 'Git status unavailable', details: JSON.stringify(diagnostics) }, error: 'Git status unavailable', details: undefined },
  { name: 'HTML details', payload: { error: 'Git status unavailable', details: '<html>proxy diagnostics</html>' }, error: 'Git status unavailable', details: undefined },
  { name: 'native branch traceback', payload: { error: '无法确认远端 Git 状态，未执行分支切换: 远端同步未确认: exit status 1: Traceback (most recent call last): File "<string>", line 28, in <module> RuntimeError: unknown option' }, error: '无法确认远端 Git 状态，未执行分支切换: 远端同步未确认', details: undefined },
  { name: 'traceback details', payload: { error: 'Git status unavailable', details: 'Traceback (most recent call last): File "<string>", line 9, in git RuntimeError: private internals' }, error: 'Git status unavailable', details: undefined },
  { name: 'embedded proxy page', payload: { error: 'Git status unavailable: <html>proxy diagnostics</html>' }, error: 'Git status unavailable', details: undefined },
  { name: 'long multiline details', payload: { error: 'Git status unavailable', details: `  Reconnect\n${'a'.repeat(300)}  ` }, error: 'Git status unavailable', details: `Reconnect ${'a'.repeat(229)}…` },
])('status renders $name as user text and recovers on refresh', async ({ payload, error, details }) => {
  calls.status.mockResolvedValueOnce(response(payload, 503));
  const hook = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await settle();
  const status = hook.result.current.gitStatus;
  expect(status?.error).toBe(error);
  expect(status?.details).toBe(details);
  const view = render(<GitRepositoryErrorState error={status!.error!} details={status!.details} />);
  expect(screen.getByRole('heading').textContent).toBe(error);
  if (details) expect(screen.getByText(details)).toBeTruthy();
  expect(view.container.textContent).not.toMatch(/transportCode|elapsedMs|\[object Object\]|\{"/);
  expect(hook.result.current.isLoading).toBe(false);
  await act(async () => { hook.result.current.refreshAll(); });
  expect(hook.result.current.gitStatus).toMatchObject({ branch: 'main' });
  expect(hook.result.current.currentBranch).toBe('main');
});

test('missing-repository responses still offer initialization', async () => {
  calls.status.mockResolvedValueOnce(response({ error: 'Not a git repository', details: 'Run git init first.', notGitRepository: true }));
  const hook = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await settle();
  const status = hook.result.current.gitStatus!;
  const init = vi.fn();
  render(<GitRepositoryErrorState error={status.error!} details={status.details} canInitRepository={status.notGitRepository} onInitRepository={init} />);
  screen.getByRole('button', { name: 'git:errorState.runGitInit' }).click();
  expect(init).toHaveBeenCalledOnce();
});

test.each([
  { name: 'HTML timeout page', body: '<html><title>524 A timeout occurred</title><body>proxy diagnostics</body></html>' },
  { name: 'empty body', body: '' },
  { name: 'JSON without an error', body: JSON.stringify({}) },
  { name: 'JSON null', body: 'null' },
])('HTTP failures with $name show a concise error for status and writes', async ({ body }) => {
  calls.status.mockResolvedValueOnce(new Response(body, { status: 524 }));
  calls.checkout.mockResolvedValueOnce(new Response(body, { status: 524 }));
  const hook = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await settle();
  const status = hook.result.current.gitStatus!;
  render(<GitRepositoryErrorState error={status.error!} details={status.details} />);
  expect(screen.getByText('Git request failed (HTTP 524)')).toBeTruthy();
  expect(hook.result.current.currentBranch).toBe('');
  expect(hook.result.current.isLoading).toBe(false);
  await act(async () => { expect(await hook.result.current.switchBranch('feature')).toBe(false); });
  expect(hook.result.current.operationError).toBe('Git request failed (HTTP 524)');
  expect(hook.result.current.isBranchBusy).toBe(false);
  expect(calls.status).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).not.toMatch(/<html>|proxy diagnostics|SyntaxError|Unexpected token|\[object Object\]/);
});

test('a non-success HTTP response cannot report a successful branch write', async () => {
  calls.checkout.mockResolvedValueOnce(response({ success: true, details: diagnostics }, 503));
  const hook = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await settle();
  await act(async () => { expect(await hook.result.current.switchBranch('feature')).toBe(false); });
  expect(hook.result.current.operationError).toBe('Git request failed (HTTP 503)');
  expect(hook.result.current.currentBranch).toBe('main');
  expect(calls.status).toHaveBeenCalledTimes(1);
});

test('an aborted stale response cannot overwrite the current project with a parse failure', async () => {
  let resolve!: (value: unknown) => void;
  const body = new Promise<unknown>(done => { resolve = done; });
  const staleResponse = new Response('', { status: 524 });
  vi.spyOn(staleResponse, 'json').mockReturnValueOnce(body);
  calls.status.mockResolvedValueOnce(staleResponse);
  const hook = renderHook(({ selectedProject }) => useGitPanelController({ selectedProject, activeView: 'changes' }), { initialProps: { selectedProject: project } });
  await settle();
  const signal = calls.status.mock.calls[0][1].signal as AbortSignal;
  hook.rerender({ selectedProject: { ...project, projectId: 'b' } });
  await settle();
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve({ error: { code: 'UNAVAILABLE' }, details: diagnostics }); });
  expect(hook.result.current.gitStatus).toMatchObject({ branch: 'main' });
  expect(hook.result.current.gitStatus?.error).toBeUndefined();
  expect(hook.result.current.isLoading).toBe(false);
});

test('invalid JSON on a successful HTTP response is an error, not an empty repository', async () => {
  calls.status.mockResolvedValueOnce(new Response('<html>unexpected login page</html>', { status: 200 }));
  const hook = renderHook(() => useGitPanelController({ selectedProject: project, activeView: 'changes' }));
  await settle();
  const status = hook.result.current.gitStatus!;
  render(<GitRepositoryErrorState error={status.error!} details={status.details} />);
  expect(screen.getByText('Git returned an invalid response. Please try again.')).toBeTruthy();
  expect(hook.result.current.currentBranch).toBe('');
  expect(document.body.textContent).not.toMatch(/<html>|unexpected login page|SyntaxError|Unexpected token/);
});
