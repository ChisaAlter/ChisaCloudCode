import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import GitViewTabs from '@/modules/git-panel/GitViewTabs';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import type { WorkspaceDescriptor } from '@/shared/types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const local: WorkspaceDescriptor = {
  workspaceId: 'local-one', generation: 'gen-one', projectId: 'project', kind: 'cloudReplica', rootPath: '/meta/project', sourceRoot: '/meta/project',
  sourceMode: 'ssh', displayPath: 'C:\\work\\项目', connectionState: 'offline', requestedMode: 'shared', effectiveMode: 'shared', phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};

test('local git has no isolated worktree management tab', () => {
  render(<WorkspaceScopeContext.Provider value={local}><GitViewTabs activeView="changes" isHidden={false} changeCount={0} onChange={vi.fn()} /></WorkspaceScopeContext.Provider>);
  expect(screen.queryByRole('tab', { name: 'git:tabs.worktrees' })).toBeNull();
  expect(screen.getByRole('tab', { name: 'git:tabs.branches' })).toBeDefined();
});
