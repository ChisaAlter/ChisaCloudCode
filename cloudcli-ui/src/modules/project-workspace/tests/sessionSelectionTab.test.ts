import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Regression guard for the stranded-panel navigation bug.
 *
 * The active workspace tab is persisted in localStorage. Selecting a session
 * used to reset it only for the tasks and browser tabs, so a conversation
 * opened while the Git panel was active kept 源代码管理 on screen: the sidebar
 * switched to the conversation list while the chat stayed hidden behind the
 * panel, and there was no obvious way back.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const session: ProjectSession = { id: 'session-1', summary: 'Work' } as ProjectSession;

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [session],
  sessionMeta: { hasMore: false, total: 1 },
};

const renderProjectsState = async () => {
  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: () => () => {},
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project] });
});

afterEach(() => {
  vi.resetModules();
});

test('selecting a conversation returns to the chat tab from the Git panel', async () => {
  const { result } = await renderProjectsState();

  await waitFor(() => {
    assert.equal(result.current.selectedProject?.projectId, 'project-1');
  });

  act(() => {
    result.current.setActiveTab('git');
  });
  assert.equal(result.current.activeTab, 'git');

  act(() => {
    result.current.handleSessionSelect(session);
  });

  assert.equal(result.current.activeTab, 'chat');
  assert.equal(result.current.selectedSession?.id, 'session-1');
});

test('a persisted panel tab does not survive the first conversation open', async () => {
  localStorage.setItem('activeTab', 'files');

  const { result } = await renderProjectsState();

  await waitFor(() => {
    assert.equal(result.current.activeTab, 'files');
  });

  act(() => {
    result.current.handleSessionSelect(session);
  });

  assert.equal(result.current.activeTab, 'chat');
});
