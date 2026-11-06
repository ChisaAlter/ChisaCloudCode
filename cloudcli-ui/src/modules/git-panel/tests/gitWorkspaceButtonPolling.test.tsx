import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { GitWorkspaceButton } from '@/modules/git-panel/GitWorkspaceButton';
import { acknowledgeAuthSession, clearAuthToken, initializeAuthSession, startAuthSession } from '@/shared/authToken';
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
beforeEach(async () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ userId: 'git-button-account', iat: issuedAt, exp: issuedAt + 3600 })}`;
  const token = `${unsigned}.${createHmac('sha256', 'git-button-polling-test-key').update(unsigned).digest('base64url')}`;
  await clearAuthToken(await initializeAuthSession());
  const session = await startAuthSession(token, await initializeAuthSession());
  expect(session, 'Git button fixture login must commit before rendering').not.toBeNull();
  if (!session) throw new Error('Git button fixture login did not commit');
  acknowledgeAuthSession(session);
  pending.length = 0;
  vi.stubGlobal('mygo', undefined);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
});
afterEach(async () => { cleanup(); await clearAuthToken(); vi.unstubAllGlobals(); });

test('a slow background Git request survives its own running/write-permission polls', async () => {
  const view = render(content(workspace));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
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
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  const secondSignal = fetchMock.mock.calls[1][1]?.signal;
  view.rerender(content({ ...workspace, generation: 'two', capabilities: { ...workspace.capabilities, git: false } }));
  expect(secondSignal?.aborted).toBe(true);
  expect(screen.getByRole('button', { name: 'Git' }).hasAttribute('disabled')).toBe(true);
});
