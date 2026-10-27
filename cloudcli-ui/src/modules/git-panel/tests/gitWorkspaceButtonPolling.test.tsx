import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GitWorkspaceButton } from '@/modules/git-panel/GitWorkspaceButton';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import type { WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'local', generation: 'one', kind: 'cloudReplica', sourceMode: 'ssh',
  rootPath: '/meta/project', sourceRoot: '/meta/project', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated', connectionState: 'offline',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
const fetchMock = vi.fn<typeof fetch>();
const pending: ((response: Response) => void)[] = [];
const content = (scope: WorkspaceDescriptor) => <WorkspaceScopeContext.Provider value={scope}><GitWorkspaceButton projectId="project" active={false} onClick={() => {}} /></WorkspaceScopeContext.Provider>;
beforeEach(() => {
  pending.length = 0;
  vi.stubGlobal('mygo', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test('a slow background Git request survives its own running/write-permission polls', async () => {
  const view = render(content(workspace));
  expect(fetchMock).toHaveBeenCalledOnce();
  const signal = fetchMock.mock.calls[0][1]?.signal;
  for (let index = 0; index < 4; index++) {
    view.rerender(content({ ...workspace, phase: 'running', connectionState: 'online', capabilities: { ...workspace.capabilities, write: index % 2 === 0 } }));
  }
  expect(signal?.aborted).toBe(false);
  expect(fetchMock).toHaveBeenCalledOnce();
  await act(async () => { pending[0](Response.json({ branch: 'main' })); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Git' }).title).toBe('Git · main'));
  view.rerender(content({ ...workspace, generation: 'two' }));
  expect(signal?.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const secondSignal = fetchMock.mock.calls[1][1]?.signal;
  view.rerender(content({ ...workspace, generation: 'two', capabilities: { ...workspace.capabilities, git: false } }));
  expect(secondSignal?.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Git' }).hasAttribute('disabled')).toBe(true);
});
