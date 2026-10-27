import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ProjectMemoryPanel from '@/modules/project-settings/ProjectMemoryPanel';
import ProjectSettingsDialog from '@/modules/project-settings/ProjectSettingsDialog';
import { api } from '@/shared/api';
import { clearAuthToken, startAuthSession } from '@/shared/authToken';

const service = vi.hoisted(() => ({ version: 0 }));
vi.mock('@/shared/chisa', () => ({ getServerConnectionVersion: () => service.version }));
const initial = { content: 'Project conventions', hash: 'base-hash' };
const response = (data = initial) => Response.json({ success: true, data });
const editor = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: '项目记忆内容' });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { service.version = 0; startAuthSession('account.payload.signature'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function loaded() {
  await screen.findByRole('textbox', { name: '项目记忆内容' });
  await waitFor(() => expect(editor().disabled).toBe(false));
}

test('loading cannot write; empty memory can be edited and saved only with the loaded hash', async () => {
  const pending = deferred<Response>();
  vi.spyOn(api, 'projectMemory').mockReturnValue(pending.promise);
  const save = vi.spyOn(api, 'saveProjectMemory').mockImplementation(async () => response({ content: 'New convention', hash: 'new-hash' }));
  render(<ProjectMemoryPanel projectId="one" />);
  expect(screen.getByText('正在读取项目记忆…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '保存项目记忆' })).toBeNull();
  await act(async () => { pending.resolve(response({ content: '', hash: 'empty-hash' })); });
  await loaded();
  expect(screen.getByText('云端项目记忆为空。')).toBeTruthy();
  fireEvent.change(editor(), { target: { value: 'New convention' } });
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存项目记忆' }));
  await screen.findByText('项目记忆已保存。');
  expect(save).toHaveBeenCalledExactlyOnceWith('one', { content: 'New convention', expectedHash: 'empty-hash' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
});

test('clearing only empties the draft until explicit save commits empty content', async () => {
  vi.spyOn(api, 'projectMemory').mockImplementation(async () => response());
  const save = vi.spyOn(api, 'saveProjectMemory').mockImplementation(async () => response({ content: '', hash: 'cleared-hash' }));
  render(<ProjectMemoryPanel projectId="one" />);
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: '清空草稿' }));
  expect(editor().value).toBe('');
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存项目记忆' }));
  await screen.findByText('已保存空记忆。');
  expect(save).toHaveBeenCalledWith('one', { content: '', expectedHash: initial.hash }, expect.anything());
});

test('CAS conflict keeps draft and original hash until explicit latest-version merge', async () => {
  vi.spyOn(api, 'projectMemory').mockImplementationOnce(async () => response()).mockImplementation(async () => response({ content: 'Another editor changed this', hash: 'latest-hash' }));
  const save = vi.spyOn(api, 'saveProjectMemory').mockResolvedValueOnce(Response.json({ error: { code: 'MEMORY_CONFLICT', message: 'private server diagnostic' } }, { status: 409 })).mockImplementation(async () => response({ content: 'My merged draft', hash: 'merged-hash' }));
  render(<ProjectMemoryPanel projectId="one" />);
  await loaded();
  fireEvent.change(editor(), { target: { value: 'My draft' } });
  fireEvent.click(screen.getByRole('button', { name: '保存项目记忆' }));
  await screen.findByText(/云端记忆已被更新，草稿已保留/);
  expect(editor().value).toBe('My draft');
  expect(screen.queryByText('private server diagnostic')).toBeNull();
  expect((screen.getByRole('button', { name: '保存项目记忆' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '刷新云端版本' }));
  await screen.findByRole('button', { name: '保留草稿，以云端版本为基准' });
  expect(editor().value).toBe('My draft');
  fireEvent.click(screen.getByRole('button', { name: '保留草稿，以云端版本为基准' }));
  expect(editor().value).toBe('My draft');
  fireEvent.change(editor(), { target: { value: 'My merged draft' } });
  fireEvent.click(screen.getByRole('button', { name: '保存项目记忆' }));
  await screen.findByText('项目记忆已保存。');
  expect(save.mock.calls[0][1]).toEqual({ content: 'My draft', expectedHash: 'base-hash' });
  expect(save.mock.calls[1][1]).toEqual({ content: 'My merged draft', expectedHash: 'latest-hash' });
});

test('refresh preserves dirty content until explicit cloud replacement and never polls', async () => {
  const read = vi.spyOn(api, 'projectMemory').mockImplementationOnce(async () => response()).mockImplementation(async () => response({ content: 'Cloud content', hash: 'cloud-hash' }));
  render(<ProjectMemoryPanel projectId="one" />);
  await loaded();
  fireEvent.change(editor(), { target: { value: 'Keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: '刷新云端版本' }));
  await screen.findByRole('button', { name: '载入云端版本并替换草稿' });
  expect(editor().value).toBe('Keep this draft');
  fireEvent.click(screen.getByRole('button', { name: '载入云端版本并替换草稿' }));
  expect(editor().value).toBe('Cloud content');
  vi.useFakeTimers();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(read).toHaveBeenCalledTimes(2);
});

test('a failed initial read supports retry without enabling a write or showing raw diagnostics', async () => {
  vi.spyOn(api, 'projectMemory').mockRejectedValueOnce(new Error('secret-like transport body')).mockImplementation(async () => response());
  render(<ProjectMemoryPanel projectId="one" />);
  await screen.findByRole('alert');
  expect(screen.queryByText(/secret-like/)).toBeNull();
  expect(screen.queryByRole('button', { name: '保存项目记忆' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '刷新云端版本' }));
  await loaded();
  expect(editor().value).toBe(initial.content);
});

test.each(['project', 'account', 'server'] as const)('a late parsed read cannot publish into a different %s owner', async transition => {
  const body = deferred<{ success: true; data: typeof initial }>();
  const json = vi.fn(() => body.promise);
  const read = vi.spyOn(api, 'projectMemory').mockResolvedValueOnce({ ok: true, json } as unknown as Response).mockImplementation(async () => response({ content: 'Next owner memory', hash: 'next' }));
  const view = render(<ProjectMemoryPanel projectId="one" />);
  await waitFor(() => expect(json).toHaveBeenCalled());
  if (transition === 'account') clearAuthToken();
  if (transition === 'server') service.version += 1;
  view.rerender(<ProjectMemoryPanel projectId={transition === 'project' ? 'two' : 'one'} />);
  await loaded();
  await act(async () => { body.resolve({ success: true, data: initial }); });
  expect(editor().value).toBe('Next owner memory');
  expect(read.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test('a pending save after an account change cannot replace the next account draft', async () => {
  const pending = deferred<Response>();
  vi.spyOn(api, 'projectMemory').mockImplementation(async () => response());
  const save = vi.spyOn(api, 'saveProjectMemory').mockReturnValue(pending.promise);
  const view = render(<ProjectMemoryPanel projectId="one" />);
  await loaded();
  fireEvent.change(editor(), { target: { value: 'A unsaved content' } });
  fireEvent.click(screen.getByRole('button', { name: '保存项目记忆' }));
  clearAuthToken();
  view.rerender(<ProjectMemoryPanel projectId="one" />);
  await loaded();
  fireEvent.change(editor(), { target: { value: 'B draft' } });
  await act(async () => { pending.resolve(response({ content: 'A saved content', hash: 'a' })); });
  expect(editor().value).toBe('B draft');
  expect(save.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(screen.queryByText('项目记忆已保存。')).toBeNull();
});

test('the fourth settings tab opens memory lazily without changing project defaults', async () => {
  vi.spyOn(api, 'projectSettings').mockImplementation(async () => Response.json({ success: true, data: { projectId: 'one', sourceMode: 'ssh', settings: { provider: null, model: null, effort: null, permissionMode: null, workspaceMode: null }, constraints: { providers: ['claude'], workspaceMode: 'shared' }, updatedAt: null } }));
  const read = vi.spyOn(api, 'projectMemory').mockImplementation(async () => response());
  render(<ProjectSettingsDialog projectId="one" projectName="App" sourceMode="ssh" open onClose={vi.fn()} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('tab', { name: '项目记忆' }));
  await loaded();
  expect(screen.getByText(/保存在云端，按当前应用账号与项目隔离/)).toBeTruthy();
  expect(screen.getByRole('tab', { name: '项目记忆' }).getAttribute('aria-selected')).toBe('true');
  expect(read).toHaveBeenCalledTimes(1);
});
