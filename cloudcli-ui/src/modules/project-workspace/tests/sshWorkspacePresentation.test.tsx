import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { WorkspaceScopeBar } from '@/modules/project-workspace/WorkspaceScopeBar';
import { api } from '@/shared/api';
import type { WorkspaceDescriptor } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const local: WorkspaceDescriptor = {
  workspaceId: 'local-one', generation: 'gen-one', projectId: 'project', kind: 'cloudReplica', rootPath: '/meta/project', sourceRoot: '/meta/project',
  sourceMode: 'ssh', displayPath: 'C:\\work\\项目', connectionState: 'offline', requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const props = (workspace = local) => ({ selectionKey: 'local', workspace, session: null, kind: 'cloudReplica' as const, hasSession: true, loading: false, error: null, onSelect: vi.fn(), onRefresh: vi.fn() });

const openStatus = () => fireEvent.click(screen.getByRole('button', { name: '本地工作区状态' }));

test('local scope reveals Windows path and offline status from one compact control', () => {
  render(<WorkspaceScopeBar {...props()} />);
  expect(screen.getByRole('button', { name: '本地工作区状态' }).textContent).toContain('连接断开');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByText(/Windows 命令逐行执行/)).toBeNull();
  openStatus();
  expect(screen.getByText('C:\\work\\项目')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toContain('离线');
  expect(screen.queryByRole('button', { name: '会话工作区' })).toBeNull();
  expect(screen.queryByRole('button', { name: '预览并集成到云端' })).toBeNull();
  expect(screen.queryByText(/\/meta\/project/)).toBeNull();
  expect((screen.getByText('连接详情').parentElement as HTMLDetailsElement).open).toBe(false);
});

test('healthy status keeps the canvas quiet and supports refresh, Escape and focus return', () => {
  const refresh = vi.fn();
  render(<WorkspaceScopeBar {...props({ ...local, connectionState: 'online' })} onRefresh={refresh} agentStatus={<p>账号登记已确认，项目目录仍需验证</p>} />);
  const trigger = screen.getByRole('button', { name: '本地工作区状态' });
  expect(trigger.textContent).toBe('本地');
  expect(screen.queryByText('C:\\work\\项目')).toBeNull();
  expect(screen.queryByText(/项目目录仍需验证/)).toBeNull();
  trigger.focus();
  openStatus();
  expect(screen.getByRole('dialog', { name: '本地工作区详情' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByText(/项目目录仍需验证/)).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

test.each([
  [{ ...local, phase: 'running' as const, connectionState: 'online' as const, capabilities: { ...local.capabilities, write: false } }, '任务运行或检查占用中'],
  [{ ...local, phase: 'recovery' as const, connectionState: 'recovery' as const, capabilities: { ...local.capabilities, write: false } }, '等待确认上次操作结果'],
  [{ ...local, connectionState: 'offline' as const, capabilities: { ...local.capabilities, write: false } }, '连接离线'],
  [{ ...local, connectionState: 'online' as const, capabilities: { ...local.capabilities, write: false } }, '只读：服务器未授予写入权限'],
])('local access status explains actual occupancy, recovery, connectivity or readonly: %s', (workspace, expected) => {
  render(<WorkspaceScopeBar {...props(workspace)} />);
  openStatus();
  expect(screen.getByRole('status').textContent).toContain(expected);
  expect(screen.getByRole('status').textContent).not.toContain('当前不可写');
});

test('pending resolution and failed resolution do not claim permanent readonly from an older descriptor', () => {
  const blocked = { ...local, capabilities: { ...local.capabilities, write: false } };
  const view = render(<WorkspaceScopeBar {...props(blocked)} loading />);
  openStatus();
  expect(screen.getByRole('status').textContent).toBe('正在检查本地工作区…');
  view.rerender(<WorkspaceScopeBar {...props(blocked)} error="连接检查超时" />);
  expect(screen.getByRole('alert').textContent).toBe('连接检查超时');
  expect(screen.getByRole('button', { name: '本地工作区状态' }).textContent).toContain('连接断开');
});

test('local recovery checks or stops the exact current target and waits for real status', async () => {
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'running', jobId: 'job-one' })).mockResolvedValueOnce(Response.json({ status: 'idle' }));
  const refresh = vi.fn();
  render(<WorkspaceScopeBar {...props({ ...local, phase: 'recovery', connectionState: 'recovery' })} onRefresh={refresh} />);
  expect(screen.getByRole('button', { name: '本地工作区状态' }).textContent).toContain('需恢复');
  expect(screen.queryByRole('button', { name: '检查原任务' })).toBeNull();
  openStatus();
  fireEvent.click(screen.getByRole('button', { name: '检查原任务' }));
  await screen.findByText(/原本地任务仍在运行/);
  expect(recover).toHaveBeenNthCalledWith(1, { projectId: 'project', generation: 'gen-one' });
  fireEvent.click(screen.getByRole('button', { name: '停止原任务并恢复' }));
  await screen.findByText('已确认本地任务结束，可以继续操作。');
  expect(recover).toHaveBeenNthCalledWith(2, { projectId: 'project', generation: 'gen-one', cancel: true });
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
});

test('recovered metadata without a confirmed receipt asks the user to inspect prior changes', async () => {
  vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValue(Response.json({ status: 'idle', inspectChanges: true }));
  render(<WorkspaceScopeBar {...props({ ...local, phase: 'recovery', connectionState: 'recovery' })} />);
  openStatus();
  fireEvent.click(screen.getByRole('button', { name: '检查原任务' }));
  await screen.findByText('已恢复连接，请检查上次改动结果后继续。');
  expect(screen.queryByText('已确认本地任务结束，可以继续操作。')).toBeNull();
});

test('a manual recovery response from an old generation cannot update or refresh its replacement', async () => {
  let finish!: (response: Response) => void;
  const recover = vi.spyOn(api.sshWorkspaces, 'recover').mockImplementationOnce(() => new Promise<Response>(done => { finish = done; }));
  const refresh = vi.fn();
  const recovering = { ...local, phase: 'recovery' as const, connectionState: 'recovery' as const };
  const view = render(<WorkspaceScopeBar {...props(recovering)} onRefresh={refresh} />);
  openStatus();
  fireEvent.click(screen.getByRole('button', { name: '检查原任务' }));
  fireEvent.click(screen.getByRole('button', { name: '检查原任务' }));
  expect(recover).toHaveBeenCalledOnce();
  view.rerender(<WorkspaceScopeBar {...props({ ...recovering, generation: 'replacement' })} onRefresh={refresh} />);
  await act(async () => finish(Response.json({ status: 'idle' })));
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByText('已确认本地任务结束，可以继续操作。')).toBeNull();
  expect((screen.getByRole('button', { name: '检查原任务' }) as HTMLButtonElement).disabled).toBe(false);
});

test('an unmounted manual recovery cannot deliver its result to a remounted status control', async () => {
  let finish!: (response: Response) => void;
  vi.spyOn(api.sshWorkspaces, 'recover').mockImplementationOnce(() => new Promise<Response>(done => { finish = done; }));
  const refresh = vi.fn();
  const recovering = { ...local, phase: 'recovery' as const, connectionState: 'recovery' as const };
  const first = render(<WorkspaceScopeBar {...props(recovering)} onRefresh={refresh} />);
  openStatus();
  fireEvent.click(screen.getByRole('button', { name: '检查原任务' }));
  first.unmount();
  render(<WorkspaceScopeBar {...props(recovering)} onRefresh={refresh} />);
  openStatus();
  await act(async () => finish(Response.json({ status: 'idle' })));
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.queryByText('已确认本地任务结束，可以继续操作。')).toBeNull();
});

test('local recovery streams incremental job output inside the status dialog while a task is still running', async () => {
  vi.spyOn(api.sshWorkspaces, 'recover').mockResolvedValueOnce(Response.json({ status: 'running', jobId: 'job-live-1' }));
  const jobOutput = vi.spyOn(api.sshWorkspaces, 'jobOutput').mockImplementation(async (body) => {
    if (body.stream === 'stdout' && (body.offset ?? 0) === 0) {
      return Response.json({
        ok: true,
        jobId: 'job-live-1',
        stream: 'stdout',
        offset: 0,
        total: 15,
        chunk: btoa('Compiling 42%\n'),
        eof: false,
        state: 'running',
        truncated: false,
      });
    }
    return Response.json({
      ok: true,
      jobId: 'job-live-1',
      stream: body.stream ?? 'stdout',
      offset: body.offset ?? 0,
      total: body.offset ?? 0,
      chunk: '',
      eof: true,
      state: 'completed',
      truncated: false,
    });
  });

  render(<WorkspaceScopeBar {...props({ ...local, phase: 'recovery', connectionState: 'recovery' })} />);
  openStatus();
  fireEvent.click(screen.getByRole('button', { name: '检查原任务' }));

  const livePre = await screen.findByLabelText('本地任务实时输出');
  expect(livePre.textContent).toContain('Compiling 42%');
  expect(jobOutput).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: 'project',
      generation: 'gen-one',
      jobId: 'job-live-1',
      stream: 'stdout',
      offset: 0,
    }),
    expect.anything(),
  );
});
