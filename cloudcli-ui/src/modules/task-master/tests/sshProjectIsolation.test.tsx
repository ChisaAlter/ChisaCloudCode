import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { TaskMasterProvider, useTaskMaster } from '@/modules/task-master/context/TaskMasterContext';
import { useTaskMasterProjectSync } from '@/modules/task-master/hooks/useTaskMasterProjectSync';
import type { Project, ServerEvent } from '@/shared/types';

const requests = vi.hoisted(() => ({ info: vi.fn(), tasks: vi.fn(), mcp: vi.fn() }));
const auth = vi.hoisted(() => ({ user: { id: 1 }, token: 'test-token', isLoading: false }));
vi.mock('@/modules/auth', () => ({ useAuth: () => auth }));
vi.mock('@/shared/api', () => ({ api: { projectTaskmaster: requests.info, taskmaster: { tasks: requests.tasks, mcpStatus: requests.mcp } } }));
const events = vi.hoisted(() => ({ listener: null as ((event: ServerEvent) => void) | null }));
const socket = { subscribe: (listener: (event: ServerEvent) => void) => { events.listener = listener; return () => { events.listener = null; }; } };
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => socket }));

const cloud: Project = { projectId: 'cloud', displayName: 'Cloud', fullPath: '/cloud/project' };
const local: Project = { projectId: 'local', displayName: 'Local', fullPath: '/meta/local', sourceMode: 'ssh' };
beforeEach(() => {
  vi.resetAllMocks();
  requests.info.mockImplementation(async () => Response.json({ taskmaster: { hasTaskmaster: true } }));
  requests.tasks.mockImplementation(async () => Response.json({ tasks: [] }));
  requests.mcp.mockImplementation(async () => Response.json({}));
});
afterEach(cleanup);

test('direct SSH selection never starts project TaskMaster queries', async () => {
  const { result } = renderHook(useTaskMaster, { wrapper: TaskMasterProvider });
  await act(async () => {
    result.current.setCurrentProject(local);
    await result.current.refreshTasks();
  });
  expect(result.current.currentProject).toBeNull();
  expect(requests.info).not.toHaveBeenCalled();
  expect(requests.tasks).not.toHaveBeenCalled();
});

test('switching from cloud to SSH clears context and ignores pending cloud results and broadcasts', async () => {
  let finishInfo!: (response: Response) => void;
  let finishTasks!: (response: Response) => void;
  requests.info.mockImplementation(() => new Promise<Response>(resolve => { finishInfo = resolve; }));
  requests.tasks.mockImplementation(() => new Promise<Response>(resolve => { finishTasks = resolve; }));
  const { result, rerender } = renderHook(({ project }: { project: Project | null }) => {
    useTaskMasterProjectSync(project);
    return useTaskMaster();
  }, { initialProps: { project: cloud as Project | null }, wrapper: TaskMasterProvider });
  await waitFor(() => expect(requests.tasks).toHaveBeenCalledWith('cloud'));
  expect(requests.info).toHaveBeenCalledWith('cloud');
  rerender({ project: local });
  expect(result.current.currentProject).toBeNull();
  await act(async () => {
    finishInfo(Response.json({ taskmaster: { hasTaskmaster: true } }));
    finishTasks(Response.json({ tasks: [{ id: 'old', title: 'Old cloud task', status: 'pending' }] }));
  });
  expect(result.current.projectTaskMaster).toBeNull();
  expect(result.current.tasks).toEqual([]);
  expect(result.current.nextTask).toBeNull();
  expect(result.current.isLoadingTasks).toBe(false);
  requests.info.mockClear();
  requests.tasks.mockClear();
  await act(async () => {
    events.listener?.({ type: 'taskmaster-project-updated', projectId: 'cloud' } as unknown as ServerEvent);
    events.listener?.({ type: 'taskmaster-tasks-updated', projectId: 'local' } as unknown as ServerEvent);
    await result.current.refreshTasks();
  });
  expect(requests.info).not.toHaveBeenCalled();
  expect(requests.tasks).not.toHaveBeenCalled();
});

test('a null workspace selection clears a previous cloud TaskMaster target', async () => {
  const { result, rerender } = renderHook(({ project }: { project: Project | null }) => {
    useTaskMasterProjectSync(project);
    return useTaskMaster();
  }, { initialProps: { project: cloud as Project | null }, wrapper: TaskMasterProvider });
  await waitFor(() => expect(result.current.currentProject?.projectId).toBe('cloud'));
  rerender({ project: null });
  expect(result.current.currentProject).toBeNull();
});
