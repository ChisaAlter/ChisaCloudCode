import { createRef } from 'react';
import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import { api } from '@/shared/api';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import type { LLMProvider, WorkspaceDescriptor } from '@/shared/types';

const initialWorkspace: WorkspaceDescriptor = {
  projectId: 'stable-project', workspaceId: 'session:one', generation: 'one', sessionId: 'one', kind: 'session',
  rootPath: '/isolated/one', sourceRoot: '/source', requestedMode: 'isolated', effectiveMode: 'isolated', phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
};
const project = { projectId: 'stable-project', displayName: 'Stable project', fullPath: '/fallback' };
const commandsResponse = (name = '/current') => Response.json({ builtIn: [{ name }], custom: [] });
const skillsResponse = (command = '/skill') => Response.json({ success: true, data: { skills: [{ name: 'Skill', command, scope: 'project' }] } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('twenty polling snapshots and input edits keep a single catalogue lookup; generation and read eligibility still invalidate it', async () => {
  const commands = vi.spyOn(api.commands, 'list').mockImplementation(async () => commandsResponse());
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => skillsResponse());
  let scope: WorkspaceDescriptor = initialWorkspace;
  const view = renderHook(({ input, provider }: { input: string; provider: LLMProvider }) => useSlashCommands({
    selectedProject: { ...project }, provider, input, setInput: vi.fn(), textareaRef: createRef<HTMLTextAreaElement>(), onExecuteCommand: vi.fn(),
  }), { initialProps: { input: '', provider: 'claude' as LLMProvider }, wrapper: ({ children }: PropsWithChildren) => <WorkspaceScopeContext.Provider value={scope}>{children}</WorkspaceScopeContext.Provider> });
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
  for (let index = 0; index < 20; index += 1) {
    scope = { ...initialWorkspace, phase: index % 2 ? 'idle' : 'running', capabilities: { ...initialWorkspace.capabilities, write: index % 2 === 0 } };
    act(() => view.rerender({ input: `/skill ${index}`, provider: 'claude' }));
  }
  expect(commands).toHaveBeenCalledTimes(1);
  expect(skills).toHaveBeenCalledTimes(1);
  expect(commands.mock.calls[0][2]?.signal?.aborted).toBe(false);
  scope = { ...initialWorkspace, generation: 'two', capabilities: { ...initialWorkspace.capabilities } };
  view.rerender({ input: '', provider: 'claude' });
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
  expect(commands).toHaveBeenCalledTimes(2);
  expect(skills).toHaveBeenCalledTimes(2);
  expect(commands.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(commands.mock.calls[1][1]).toEqual(expect.objectContaining({ generation: 'two' }));
  scope = { ...scope, capabilities: { ...scope.capabilities, read: false } };
  view.rerender({ input: '', provider: 'claude' });
  expect(view.result.current.slashCommands).toHaveLength(0);
  expect(commands.mock.calls[1][2]?.signal?.aborted).toBe(true);
  expect(commands).toHaveBeenCalledTimes(2);
  scope = { ...scope, capabilities: { ...scope.capabilities, read: true } };
  view.rerender({ input: '', provider: 'claude' });
  await waitFor(() => expect(skills).toHaveBeenCalledTimes(3));
  view.rerender({ input: '', provider: 'codex' });
  await waitFor(() => expect(skills).toHaveBeenCalledTimes(4));
  expect(skills.mock.calls[3][0]).toBe('codex');
});

test('same project id with a changed fallback path refreshes discovery without a workspace scope', async () => {
  const commands = vi.spyOn(api.commands, 'list').mockImplementation(async () => commandsResponse());
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => skillsResponse());
  const view = renderHook(({ path }) => useSlashCommands({ selectedProject: { ...project, fullPath: path }, provider: 'claude', input: '', setInput: vi.fn(), textareaRef: createRef<HTMLTextAreaElement>(), onExecuteCommand: vi.fn() }), { initialProps: { path: '/first' } });
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(2));
  view.rerender({ path: '/second' });
  await waitFor(() => expect(skills).toHaveBeenCalledTimes(2));
  expect(commands.mock.calls[1][0]).toBe('/second');
  expect(skills.mock.calls[1][1]).toEqual({ workspacePath: '/second' });
});

test('a late command body after workspace replacement cannot dispatch skills or replace the new catalogue', async () => {
  const body = deferred<{ builtIn: { name: string }[]; custom: [] }>();
  const old = commandsResponse('/old');
  vi.spyOn(old, 'json').mockReturnValueOnce(body.promise);
  const commands = vi.spyOn(api.commands, 'list').mockResolvedValueOnce(old).mockImplementation(async () => commandsResponse('/new'));
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(async () => skillsResponse('/new-skill'));
  let scope: WorkspaceDescriptor = initialWorkspace;
  const view = renderHook(() => useSlashCommands({ selectedProject: project, provider: 'claude', input: '', setInput: vi.fn(), textareaRef: createRef<HTMLTextAreaElement>(), onExecuteCommand: vi.fn() }), { wrapper: ({ children }: PropsWithChildren) => <WorkspaceScopeContext.Provider value={scope}>{children}</WorkspaceScopeContext.Provider> });
  await act(async () => {});
  scope = { ...initialWorkspace, generation: 'new' };
  view.rerender();
  await waitFor(() => expect(view.result.current.slashCommands.map(item => item.name)).toEqual(['/new', '/new-skill']));
  await act(async () => { body.resolve({ builtIn: [{ name: '/old' }], custom: [] }); });
  expect(commands.mock.calls[0][2]?.signal?.aborted).toBe(true);
  expect(skills).toHaveBeenCalledTimes(1);
  expect(view.result.current.slashCommands.map(item => item.name)).toEqual(['/new', '/new-skill']);
});

test('unmount aborts in-flight skill discovery and ignores a transport that resolves late', async () => {
  vi.spyOn(api.commands, 'list').mockImplementation(async () => commandsResponse());
  const pending = deferred<Response>();
  const skills = vi.spyOn(api.providers, 'skills').mockReturnValueOnce(pending.promise);
  const view = renderHook(() => useSlashCommands({ selectedProject: project, provider: 'claude', input: '', setInput: vi.fn(), textareaRef: createRef<HTMLTextAreaElement>(), onExecuteCommand: vi.fn() }));
  await waitFor(() => expect(skills).toHaveBeenCalledOnce());
  const signal = skills.mock.calls[0][2]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve(skillsResponse('/late')); });
});
