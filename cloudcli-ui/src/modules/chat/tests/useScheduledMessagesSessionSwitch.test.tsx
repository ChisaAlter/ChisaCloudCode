import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import { WorkspaceExecutionContext } from '@/shared/context/WorkspaceScopeContext';
import type { WorkspaceDescriptor } from '@/shared/types';
import { useScheduledMessages } from '@/modules/chat/composer/useScheduledMessages';

function listResponse(data: unknown[]): Response {
  return { json: async () => ({ data }) } as unknown as Response;
}

const MESSAGE_A = {
  id: 'sm-a',
  sessionId: 'session-a',
  content: 'from session a',
  scheduledFor: '2026-08-28T12:00:00.000Z',
  status: 'pending',
};

const WORKSPACE: WorkspaceDescriptor = {
  projectId: 'project-a', workspaceId: 'session:session-a', generation: 'one', kind: 'session', sessionId: 'session-a',
  rootPath: '/sessions/a', sourceRoot: '/replica/a', requestedMode: 'isolated', effectiveMode: 'isolated',
  phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
};
const okJson = (data: unknown = {}) => new Response(JSON.stringify(data), { status: 200 });
const input = { content: 'later task', scheduledFor: new Date('2026-12-01T10:00:00Z'), options: { model: 'saved-model' } };

afterEach(() => {
  vi.restoreAllMocks();
});

test('a scheduled message snapshots the resolved workspace for detached execution', async () => {
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));
  vi.spyOn(api.workspaces, 'resolve').mockImplementation(async () => okJson({ session: WORKSPACE }));
  const create = vi.spyOn(api.scheduledMessages, 'create').mockImplementation(async () => okJson());
  const { result } = renderHook(() => useScheduledMessages('session-a'), {
    wrapper: ({ children }: PropsWithChildren) => <WorkspaceExecutionContext.Provider value={WORKSPACE}>{children}</WorkspaceExecutionContext.Provider>,
  });
  await act(async () => { assert.equal(await result.current.schedule(input), true); });
  assert.deepEqual(create.mock.calls[0]?.[0].options, { model: 'saved-model', workspace: { projectId: WORKSPACE.projectId, workspaceId: WORKSPACE.workspaceId, generation: WORKSPACE.generation } });
});

test('an unavailable or replaced generation cannot create a scheduled task', async () => {
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));
  vi.spyOn(api.workspaces, 'resolve').mockImplementation(async () => okJson({ session: { ...WORKSPACE, generation: 'replaced' } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const create = vi.spyOn(api.scheduledMessages, 'create');
  const { result } = renderHook(() => useScheduledMessages('session-a'), {
    wrapper: ({ children }: PropsWithChildren) => <WorkspaceExecutionContext.Provider value={WORKSPACE}>{children}</WorkspaceExecutionContext.Provider>,
  });
  await act(async () => { assert.equal(await result.current.schedule(input), false); });
  assert.equal(create.mock.calls.length, 0);
});

test('late resolve and late schedule acknowledgements never consume a new session draft', async () => {
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async () => listResponse([]));
  let releaseResolve!: (response: Response) => void;
  const resolve = vi.spyOn(api.workspaces, 'resolve').mockImplementation(() => new Promise<Response>(done => { releaseResolve = done; }));
  const create = vi.spyOn(api.scheduledMessages, 'create');
  const view = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
    wrapper: ({ children }: PropsWithChildren) => <WorkspaceExecutionContext.Provider value={WORKSPACE}>{children}</WorkspaceExecutionContext.Provider>,
  });
  let pending!: Promise<boolean>;
  await act(async () => { pending = view.result.current.schedule(input); });
  view.rerender({ sessionId: 'session-b' });
  await act(async () => { releaseResolve(okJson({ session: WORKSPACE })); assert.equal(await pending, false); });
  assert.equal(create.mock.calls.length, 0);
  view.rerender({ sessionId: 'session-a' });
  resolve.mockImplementation(async () => okJson({ session: WORKSPACE }));
  let releaseCreate!: (response: Response) => void;
  create.mockImplementation(() => new Promise<Response>(done => { releaseCreate = done; }));
  await act(async () => { pending = view.result.current.schedule(input); });
  assert.equal(create.mock.calls.length, 1);
  view.rerender({ sessionId: 'session-b' });
  await act(async () => { releaseCreate(okJson()); assert.equal(await pending, false); });
});

test('switching sessions clears the previous session\'s scheduled messages immediately', async () => {
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation(async (sessionId?: string) =>
    listResponse(sessionId === 'session-a' ? [MESSAGE_A] : []));

  const { result, rerender } = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  await waitFor(() => assert.equal(result.current.scheduledMessages.length, 1));

  rerender({ sessionId: 'session-b' });

  // The banner must not linger with session A's message while B's list loads.
  assert.equal(result.current.scheduledMessages.length, 0);
});

test('a slow fetch for the previous session cannot land on the next one', async () => {
  let releaseSessionA: (() => void) | undefined;
  vi.spyOn(api.scheduledMessages, 'list').mockImplementation((sessionId?: string) => {
    if (sessionId === 'session-a') {
      return new Promise<Response>((resolve) => {
        releaseSessionA = () => resolve(listResponse([MESSAGE_A]));
      });
    }
    return Promise.resolve(listResponse([]));
  });

  const { result, rerender } = renderHook(({ sessionId }) => useScheduledMessages(sessionId), {
    initialProps: { sessionId: 'session-a' },
  });
  rerender({ sessionId: 'session-b' });
  await waitFor(() => assert.ok(releaseSessionA));

  await act(async () => {
    releaseSessionA?.();
  });

  assert.equal(result.current.scheduledMessages.length, 0);
});
