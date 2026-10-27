import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import ProjectActionsPanel from '@/modules/project-settings/ProjectActionsPanel';
import type { ProjectAction } from '@/shared/types';

const transport = vi.hoisted(() => ({
  projectActions: vi.fn(),
  createProjectAction: vi.fn(),
  updateProjectAction: vi.fn(),
  deleteProjectAction: vi.fn(),
  runProjectAction: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    projectActions: transport.projectActions,
    createProjectAction: transport.createProjectAction,
    updateProjectAction: transport.updateProjectAction,
    deleteProjectAction: transport.deleteProjectAction,
    workspaces: { runProjectAction: transport.runProjectAction },
  },
}));

vi.mock('@/shared/context/WorkspaceScopeContext', () => ({
  useWorkspaceScope: () => ({
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    generation: 'generation-1',
    kind: 'cloudReplica',
    rootPath: '/workspace/project',
    sourceRoot: '/workspace/project',
    requestedMode: 'isolated',
    effectiveMode: 'isolated',
    phase: 'idle',
    publicationState: 'integrated',
    capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
  }),
}));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const ACTION: ProjectAction = {
  id: 'action-1',
  projectId: 'project-1',
  name: 'Build',
  command: 'npm run build',
  kind: 'build',
  cwd: null,
  sortOrder: 1,
  createdAt: '2026-10-26T00:00:00.000Z',
  updatedAt: '2026-10-26T00:00:00.000Z',
};

beforeEach(() => {
  transport.projectActions.mockReset();
  transport.createProjectAction.mockReset();
  transport.updateProjectAction.mockReset();
  transport.deleteProjectAction.mockReset();
  transport.runProjectAction.mockReset();
  transport.projectActions.mockResolvedValue(json({ data: { actions: [ACTION] } }));
  transport.runProjectAction.mockResolvedValue(json({
    actionId: ACTION.id,
    command: ACTION.command,
    exitCode: 0,
    stdout: 'build ok',
    stderr: '',
    truncated: false,
    durationMs: 12,
    workspaceMode: 'bridged',
  }));
  transport.createProjectAction.mockResolvedValue(json({ data: { action: ACTION } }, 201));
});

test('runs a saved project action in the active workspace and shows its exit code', async () => {
  render(<ProjectActionsPanel projectId="project-1" />);

  await screen.findByText('Build');
  fireEvent.click(screen.getByRole('button', { name: '运行' }));

  await waitFor(() => expect(transport.runProjectAction).toHaveBeenCalledWith({
    projectId: 'project-1',
    actionId: 'action-1',
    workspaceId: 'workspace-1',
    generation: 'generation-1',
  }));
  await screen.findByText(/退出码 0/);
  expect(screen.getByText(/build ok/)).toBeTruthy();
});

test('adds a new project action with a relative working directory', async () => {
  render(<ProjectActionsPanel projectId="project-1" />);
  await screen.findByText('Build');

  fireEvent.change(screen.getByPlaceholderText('例如：运行开发服务器'), { target: { value: 'Test' } });
  fireEvent.change(screen.getByPlaceholderText('npm test'), { target: { value: 'npm test' } });
  fireEvent.change(screen.getByPlaceholderText('例如：packages/app'), { target: { value: 'packages/app' } });
  fireEvent.click(screen.getByRole('button', { name: '添加操作' }));

  await waitFor(() => expect(transport.createProjectAction).toHaveBeenCalledWith('project-1', expect.objectContaining({
    name: 'Test',
    command: 'npm test',
    cwd: 'packages/app',
  })));
});
