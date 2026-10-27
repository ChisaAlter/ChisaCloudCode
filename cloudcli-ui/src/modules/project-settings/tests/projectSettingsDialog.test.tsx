import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

import ProjectSettingsDialog from '@/modules/project-settings/ProjectSettingsDialog';
import type { ProjectSettingsView } from '@/shared/types';

const transport = vi.hoisted(() => ({
  projectSettings: vi.fn(),
  saveProjectSettings: vi.fn(),
  clearProjectSettings: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: transport }));

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const VIEW: ProjectSettingsView = {
  projectId: 'project-1',
  sourceMode: 'cloud',
  settings: {
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    effort: null,
    permissionMode: null,
    workspaceMode: 'isolated',
  },
  constraints: { providers: null, workspaceMode: null },
  updatedAt: '2026-10-26T00:00:00.000Z',
};

beforeEach(() => {
  transport.projectSettings.mockReset();
  transport.saveProjectSettings.mockReset();
  transport.clearProjectSettings.mockReset();
  transport.projectSettings.mockResolvedValue(json({ success: true, data: VIEW }));
  transport.saveProjectSettings.mockResolvedValue(json({ success: true, data: VIEW }));
  transport.clearProjectSettings.mockResolvedValue(json({
    success: true,
    data: {
      ...VIEW,
      settings: { provider: null, model: null, effort: null, permissionMode: null, workspaceMode: null },
      updatedAt: null,
    },
  }));
});

test('edits persist project defaults and restore inheritance', async () => {
  render(
    <ProjectSettingsDialog
      projectId="project-1"
      projectName="Demo project"
      open
      onClose={() => {}}
    />,
  );

  const modelInput = await screen.findByPlaceholderText('留空继承账号默认，例如 claude-sonnet-4-5');
  await waitFor(() => expect((modelInput as HTMLInputElement).value).toBe('claude-sonnet-4-5'));

  fireEvent.change(modelInput, { target: { value: 'claude-opus-4-5' } });
  fireEvent.click(screen.getByRole('button', { name: '保存项目默认值' }));

  await waitFor(() => expect(transport.saveProjectSettings).toHaveBeenCalledWith(
    'project-1',
    expect.objectContaining({
      provider: 'claude',
      model: 'claude-opus-4-5',
      workspaceMode: 'isolated',
    }),
  ));

  fireEvent.click(screen.getByRole('button', { name: '恢复继承' }));
  await waitFor(() => expect(transport.clearProjectSettings).toHaveBeenCalledWith('project-1'));
});
