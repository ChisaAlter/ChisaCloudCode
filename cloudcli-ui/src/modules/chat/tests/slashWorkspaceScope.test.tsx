import { createRef } from 'react';
import type { PropsWithChildren } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import { api } from '@/shared/api';
import { WorkspaceScopeContext } from '@/shared/context/WorkspaceScopeContext';
import type { WorkspaceDescriptor } from '@/shared/types';

const workspace: WorkspaceDescriptor = {
  projectId: 'project', workspaceId: 'session:one', generation: 'generation-one', sessionId: 'one', kind: 'session',
  rootPath: '/isolated/one', sourceRoot: '/replica/project', requestedMode: 'isolated', effectiveMode: 'isolated',
  phase: 'idle', publicationState: 'unpublished',
  capabilities: { read: true, write: true, git: true, shell: true, preview: true, integrate: true, cloudExecutionIndependentOfDesktop: true },
};
const project = { projectId: 'project', displayName: 'Project', path: '/replica/project', fullPath: '/replica/project' };
const response = (data: unknown) => Promise.resolve(Response.json(data));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('the slash menu discovers session skills by identity and rejects an unavailable scope', async () => {
  const commands = vi.spyOn(api.commands, 'list').mockImplementation(() => response({ builtIn: [], custom: [] }));
  const skills = vi.spyOn(api.providers, 'skills').mockImplementation(() => response({ success: true, data: { skills: [{ name: 'Session skill', command: '/session-skill', scope: 'project' }] } }));
  let scope: WorkspaceDescriptor | null = workspace;
  const view = renderHook(() => useSlashCommands({
    selectedProject: project, provider: 'claude', input: '', setInput: vi.fn(), textareaRef: createRef<HTMLTextAreaElement>(), onExecuteCommand: vi.fn(),
  }), { wrapper: ({ children }: PropsWithChildren) => <WorkspaceScopeContext.Provider value={scope}>{children}</WorkspaceScopeContext.Provider> });
  await waitFor(() => expect(skills).toHaveBeenCalledOnce());
  expect(skills.mock.calls[0]).toEqual(['claude', {
    projectId: workspace.projectId, workspaceId: workspace.workspaceId, generation: workspace.generation, sessionId: workspace.sessionId,
  }, { signal: expect.any(AbortSignal) }]);
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(1));
  scope = null;
  act(() => view.rerender());
  await waitFor(() => expect(view.result.current.slashCommands).toHaveLength(0));
  expect(commands).toHaveBeenCalledOnce();
  expect(skills).toHaveBeenCalledOnce();
});
