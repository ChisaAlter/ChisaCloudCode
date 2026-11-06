import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useGitPanelController } from '@/modules/git-panel/hooks/useGitPanelController';
import { acknowledgeAuthSession, clearAuthToken, initializeAuthSession, startAuthSession } from '@/shared/authToken';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import type { WorkspaceDescriptor } from '@/shared/types';

vi.mock('@/modules/git-panel/hooks/useSelectedProvider', () => ({ useSelectedProvider: () => 'claude' }));
const workspace: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'local', generation: 'one', kind: 'cloudReplica', sourceMode: 'ssh',
  rootPath: '/meta/project', sourceRoot: '/meta/project', requestedMode: 'shared', effectiveMode: 'shared',
  phase: 'idle', publicationState: 'integrated', connectionState: 'offline',
  capabilities: { read: true, write: true, git: true, shell: true, preview: false, integrate: false, cloudExecutionIndependentOfDesktop: false },
};
let current: WorkspaceDescriptor;
const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceScopeContext.Provider value={current}>{children}</WorkspaceScopeContext.Provider>;
const fetchMock = vi.fn<typeof fetch>();
const pending: ((response: Response) => void)[] = [];
beforeEach(async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 'git-panel-account', iat: issuedAt, exp: issuedAt + 3600 })}`;
  const token = `${unsigned}.${createHmac('sha256', 'git-panel-polling-test-key').update(unsigned).digest('base64url')}`;
  await clearAuthToken(await initializeAuthSession());
  const session = await startAuthSession(token, await initializeAuthSession());
  expect(session, 'Git panel fixture login must commit before rendering').not.toBeNull();
  if (!session) throw new Error('Git panel fixture login did not commit');
  acknowledgeAuthSession(session);
  current = workspace;
  pending.length = 0;
  vi.stubGlobal('mygo', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
});
afterEach(async () => { cleanup(); await clearAuthToken(); vi.unstubAllGlobals(); });

test('Git panel initialization stays alive through write/status polls and new metadata objects', async () => {
  const view = renderHook(() => useGitPanelController({ selectedProject: { projectId: 'project', displayName: current.displayPath || 'Local', fullPath: '/meta/project' }, activeView: 'changes' }), { wrapper });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const signal = fetchMock.mock.calls[0][1]?.signal;
  for (let index = 0; index < 4; index++) {
    current = { ...workspace, phase: 'running', connectionState: 'online', displayPath: `path-${index}`, capabilities: { ...workspace.capabilities, write: index % 2 === 0 } };
    view.rerender();
  }
  expect(signal?.aborted).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(async () => {
    pending[0](Response.json({ branch: 'main', modified: [], staged: [] }));
    pending[1](Response.json({ branches: ['main'], localBranches: ['main'] }));
    pending[2](Response.json({ hasRemote: false }));
  });
  expect(view.result.current.currentBranch).toBe('main');
  expect(view.result.current.isLoading).toBe(false);
  current = { ...workspace, generation: 'two' };
  view.rerender();
  expect(signal?.aborted).toBe(true);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
  expect(view.result.current.currentBranch).toBe('');
});
