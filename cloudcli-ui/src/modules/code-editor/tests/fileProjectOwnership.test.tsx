import assert from 'node:assert/strict';

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { useEditorSidebar } from '@/modules/code-editor/hooks/useEditorSidebar';
import type { Project } from '@/shared/types';

const active: Project = { projectId: 'demo-project', fullPath: '/srv/workspaces/demo-user/demo-project', displayName: 'demo-project' };
const temporary: Project = { projectId: 'tmp', fullPath: '/tmp', displayName: 'tmp' };

afterEach(cleanup);

test('absolute chat image opens through its registered owning project without switching the session', () => {
  const { result } = renderHook(() => useEditorSidebar({ selectedProject: active, projects: [active, temporary], isMobile: false }));
  act(() => result.current.handleFileOpen('/tmp/frames/after-140x38.png'));
  assert.deepEqual(result.current.editingFile, { name: 'after-140x38.png', path: '/tmp/frames/after-140x38.png', projectId: 'tmp', diffInfo: null });
  act(() => result.current.handleFileOpen('src/main.ts'));
  assert.equal(result.current.editingFile?.projectId, 'demo-project');
});

test('nested owner wins and similarly prefixed or unregistered paths do not gain access', () => {
  const nested: Project = { projectId: 'frames', fullPath: '/tmp/frames', displayName: 'frames' };
  const { result } = renderHook(() => useEditorSidebar({ selectedProject: active, projects: [temporary, nested, active], isMobile: false }));
  act(() => result.current.handleFileOpen('/tmp/frames/a.png'));
  assert.equal(result.current.editingFile?.projectId, 'frames');
  for (const path of ['/tmp-other/a.png', '/etc/passwd']) {
    act(() => result.current.handleFileOpen(path));
    assert.equal(result.current.editingFile?.projectId, 'demo-project');
  }
});
