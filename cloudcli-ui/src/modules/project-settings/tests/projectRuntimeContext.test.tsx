import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ProjectContextPanel from '@/modules/project-settings/ProjectContextPanel';
import { useProjectContext } from '@/modules/project-settings/hooks/useProjectContext';
import { api } from '@/shared/api';
import { clearAuthToken, startAuthSession } from '@/shared/authToken';
import type { ProjectContextView, ProjectRuntimeManifest } from '@/shared/types';

const service = vi.hoisted(() => ({ version: 0 }));
vi.mock('@/shared/chisa', () => ({ getServerConnectionVersion: () => service.version }));
const policy: ProjectContextView = {
  projectId: 'local-project', sourceMode: 'ssh', displayPath: 'C:\\work\\app',
  execution: { provider: 'claude', location: 'vps' }, workspace: { mode: 'bridged', instructionPath: 'CLAUDE.md' },
  instructions: { access: 'workspace-tool', note: 'Windows 指令文件按策略读取。' },
  runtime: { settingSources: [], autoMemory: false, strictMcpConfig: true, workspaceToolsOnly: true, effectiveMcpServers: ['workspace'] },
  defaults: { provider: null, model: null, effort: null, permissionMode: null, workspaceMode: null }, notes: ['策略不代表已经加载或连接。'],
};
const response = (view = policy) => Response.json({ data: view });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { service.version = 0; startAuthSession('account.payload.signature'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

test('policy without an actual run never claims instructions, skills or MCP were loaded', async () => {
  vi.spyOn(api, 'projectContext').mockImplementation(async () => response());
  render(<ProjectContextPanel projectId={policy.projectId} />);
  await screen.findByText('尚无实际运行记录');
  expect(screen.getByText(/首次发送消息后/)).toBeTruthy();
  expect(screen.queryByText('实际运行时配置')).toBeNull();
  expect(screen.getByText('配置策略')).toBeTruthy();
});

const manifest: ProjectRuntimeManifest = {
  projectId: policy.projectId, runId: 'run-real', sessionId: 'session-real', workspaceId: 'workspace-real', generation: 'gen-real', at: '2026-10-26T15:50:00Z', configRevision: 'config-sha', status: 'loaded',
  files: [{ path: 'CLAUDE.md', hash: 'file-sha', kind: 'instruction' }, { path: '.claude/rules/rule.md', hash: 'rule-sha', kind: 'rule' }],
  skills: [{ name: 'found-only', path: '.claude/skills/found/SKILL.md', status: 'available' }, { name: 'used-skill', path: '.claude/skills/used/SKILL.md', status: 'activated' }],
  mcp: [{ name: 'cloud-server', transport: 'http', location: 'cloud', status: 'selected' }, { name: 'local-server', transport: 'stdio', location: 'local', status: 'unsupported', reason: '本地 stdio 桥接尚未启用' }, { name: 'confirmed-server', transport: 'sse', location: 'cloud', status: 'connected' }],
  warnings: ['警告：此运行未加载用户自动记忆'],
};

test('actual manifest distinguishes prepared files, discovered skills and SDK-confirmed MCP connections', async () => {
  vi.spyOn(api, 'projectContext').mockImplementation(async () => response({ ...policy, runtimeManifest: manifest }));
  render(<ProjectContextPanel projectId={policy.projectId} />);
  await screen.findByText('配置已准备');
  expect(screen.getByText(/不表示模型已读取全部文件/)).toBeTruthy();
  expect(screen.getByText(/Claude 在云端运行；项目文件与工作区工具在 Windows 执行/)).toBeTruthy();
  fireEvent.click(screen.getByText('本轮标识与文件（2）'));
  expect(screen.getByText('session-real')).toBeTruthy();
  expect(screen.getByText('config-sha')).toBeTruthy();
  expect(screen.getByText('哈希：file-sha')).toBeTruthy();
  fireEvent.click(screen.getByText('技能（2）'));
  expect(screen.getByText('found-only · 已发现，未激活')).toBeTruthy();
  expect(screen.getByText('used-skill · 已激活')).toBeTruthy();
  fireEvent.click(screen.getByText('MCP（3）'));
  expect(screen.getByText('cloud-server · 已选择，未确认连接')).toBeTruthy();
  expect(screen.getByText('confirmed-server · 运行时已连接')).toBeTruthy();
  expect(screen.getByText('本地 stdio 桥接尚未启用')).toBeTruthy();
  fireEvent.click(screen.getByText('运行提示（1）'));
  expect(screen.getByText(manifest.warnings[0])).toBeTruthy();
});

test('completed manifests are historical and empty discovery lists never display readiness', async () => {
  vi.spyOn(api, 'projectContext').mockImplementation(async () => response({ ...policy, runtimeManifest: { ...manifest, status: 'completed', files: [], skills: [], mcp: [], warnings: [] } }));
  render(<ProjectContextPanel projectId={policy.projectId} />);
  await screen.findByText('该轮已结束');
  expect(screen.getByText(/不代表当前仍在运行或保持连接/)).toBeTruthy();
  expect(screen.queryByText(/运行时已连接/)).toBeNull();
  expect(screen.getByText('本轮未记录文件来源。')).toBeTruthy();
  expect(screen.getByText('本轮未记录技能发现或激活结果。')).toBeTruthy();
  expect(screen.getByText('本轮未记录 MCP 选择或连接结果。')).toBeTruthy();
});

test('manual refresh retains the last successful read when the server temporarily fails', async () => {
  const request = vi.spyOn(api, 'projectContext').mockImplementationOnce(async () => response()).mockRejectedValueOnce(new Error('connection interrupted'));
  const { result } = renderHook(() => useProjectContext(policy.projectId));
  await waitFor(() => expect(result.current.view?.projectId).toBe(policy.projectId));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.view).toEqual(policy);
  expect(result.current.error).toBe('connection interrupted');
  expect(request).toHaveBeenCalledTimes(2);
});

test.each(['account', 'server', 'project'] as const)('late parsed responses cannot cross a changed %s identity', async transition => {
  const body = deferred<{ data: ProjectContextView }>();
  const json = vi.fn(() => body.promise);
  const nextId = transition === 'project' ? 'next-project' : policy.projectId;
  const request = vi.spyOn(api, 'projectContext').mockResolvedValueOnce({ ok: true, json } as unknown as Response).mockImplementation(async () => response({ ...policy, projectId: nextId, displayPath: 'C:\\next' }));
  const { result, rerender } = renderHook(({ id }) => useProjectContext(id), { initialProps: { id: policy.projectId } });
  await waitFor(() => expect(json).toHaveBeenCalled());
  const previousRefresh = result.current.refresh;
  if (transition === 'account') clearAuthToken();
  if (transition === 'server') service.version += 1;
  rerender({ id: nextId });
  await waitFor(() => expect(result.current.view?.displayPath).toBe('C:\\next'));
  if (transition !== 'project') {
    await act(async () => { await previousRefresh(); });
    expect(request).toHaveBeenCalledTimes(2);
  }
  await act(async () => { body.resolve({ data: policy }); });
  expect(result.current.view?.displayPath).toBe('C:\\next');
  expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test('polling only runs while enabled and aborts pending reads on close', async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(api, 'projectContext').mockImplementation(async () => response());
  const { result, rerender, unmount } = renderHook(({ enabled }) => useProjectContext(policy.projectId, enabled), { initialProps: { enabled: true } });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(request).toHaveBeenCalledTimes(2);
  rerender({ enabled: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(result.current.view).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(request).toHaveBeenCalledTimes(2);
});
