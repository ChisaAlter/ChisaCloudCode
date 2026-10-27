import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';
import type { Project } from '@/shared/types';

const requests = vi.hoisted(() => ({ projects: vi.fn(), info: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { projects: requests.projects, projectTaskmaster: requests.info } }));
const cloud: Project = { projectId: 'cloud', displayName: 'Cloud', fullPath: '/cloud/project' };
const local: Project = { projectId: 'local', displayName: 'Local', fullPath: '/meta/local', sourceMode: 'ssh' };
const subscribe = () => () => {};
const isSessionProcessing = () => false;
function mount() { return renderHook(() => useProjectsState({ navigate: vi.fn(), subscribe, isMobile: false, isSessionProcessing })); }
beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });
afterEach(cleanup);

test('auto-selecting an SSH project skips cloud TaskMaster hydration', async () => {
  requests.projects.mockImplementation(async () => Response.json([local]));
  const { result } = mount();
  await waitFor(() => expect(result.current.selectedProject?.sourceMode).toBe('ssh'));
  expect(requests.info).not.toHaveBeenCalled();
});

test('pending cloud hydration cannot update project metadata after SSH selection', async () => {
  requests.projects.mockImplementation(async () => Response.json([cloud]));
  let finish!: (response: Response) => void;
  requests.info.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const { result } = mount();
  await waitFor(() => expect(requests.info).toHaveBeenCalledWith('cloud'));
  act(() => result.current.handleProjectSelect(local));
  await act(async () => { finish(Response.json({ taskmaster: { hasTaskmaster: true } })); });
  expect(result.current.selectedProject?.sourceMode).toBe('ssh');
  expect(result.current.projects.find(project => project.projectId === 'cloud')?.taskmaster).toBeUndefined();
  expect(requests.info).toHaveBeenCalledTimes(1);
});
