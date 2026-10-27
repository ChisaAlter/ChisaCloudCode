import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import ProjectContextPanel from '@/modules/project-settings/ProjectContextPanel';
import type { ProjectContextView } from '@/shared/types';

const VIEW: ProjectContextView = {
  projectId: 'project-1',
  sourceMode: 'ssh',
  displayPath: 'C:\\work\\project',
  execution: { provider: 'claude', location: 'vps' },
  workspace: { mode: 'bridged', instructionPath: 'CLAUDE.md' },
  instructions: { access: 'workspace-tool', note: '指令文件位于 Windows 项目目录。' },
  runtime: {
    settingSources: [],
    autoMemory: false,
    strictMcpConfig: true,
    workspaceToolsOnly: true,
    effectiveMcpServers: ['workspace'],
  },
  defaults: {
    provider: null,
    model: null,
    effort: null,
    permissionMode: null,
    workspaceMode: null,
  },
  notes: ['MCP / Skills 设置页中的“已配置”不等于当前会话已经加载或生效。'],
};

vi.mock('@/shared/api', () => ({
  api: {
    projectContext: vi.fn(async () => new Response(JSON.stringify({ data: VIEW }), { status: 200 })),
  },
}));

test('shows the effective workspace policy without claiming the file was read', async () => {
  render(<ProjectContextPanel projectId="project-1" />);

  await screen.findByText('工作区桥接（workspace 工具）');
  expect(screen.getByText('CLAUDE.md')).toBeTruthy();
  expect(screen.getByText('工作区工具按需读取')).toBeTruthy();
  expect(screen.getByText('原生来源关闭；显式装配项目配置')).toBeTruthy();
  expect(screen.getByText('关闭')).toBeTruthy();
  expect(screen.getByText('MCP 显式白名单（工作区、项目上下文及已批准扩展）')).toBeTruthy();
  expect(screen.getByText('尚无实际运行记录')).toBeTruthy();
  expect(screen.getByText(/不等于当前会话已经加载或生效/)).toBeTruthy();
});
