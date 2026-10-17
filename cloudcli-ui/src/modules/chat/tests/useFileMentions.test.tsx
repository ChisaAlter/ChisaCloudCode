import assert from 'node:assert/strict';

import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { useFileMentions } from '@/modules/chat/hooks/useFileMentions';
import { api } from '@/shared/api';
import type { Project } from '@/shared/types';

vi.mock('@/shared/api', () => ({ api: { getFiles: vi.fn() } }));

const PROJECT: Project = { projectId: 'project-one', displayName: 'One', fullPath: '/workspace/one' };
const OTHER_PROJECT: Project = { projectId: 'project-two', displayName: 'Two', fullPath: '/workspace/two' };
const getFiles = vi.mocked(api.getFiles);

type HookProps = { isActive: boolean; project: Project | null };

const response = (name = 'index.ts'): Response => ({
  ok: true,
  json: async () => [{ name: 'src', type: 'directory', children: [{ name, type: 'file' }] }],
}) as Response;

const setup = (initialProps: HookProps = { isActive: true, project: PROJECT }) => renderHook(
  ({ isActive, project }: HookProps) => {
    // The harness keeps the same controlled draft across tab visibility changes.
    const [input, setInput] = useState('');
    return {
      ...useFileMentions({
        isActive,
        selectedProject: project,
        input,
        setInput,
        textareaRef: { current: null },
      }),
      input,
      setInput,
    };
  },
  { initialProps },
);

beforeEach(() => getFiles.mockReset());

test('mounting, switching projects, and showing Chat do not preload a tree', () => {
  const view = setup({ isActive: false, project: null });
  view.rerender({ isActive: false, project: PROJECT });
  view.rerender({ isActive: true, project: PROJECT });
  view.rerender({ isActive: false, project: OTHER_PROJECT });
  view.rerender({ isActive: true, project: OTHER_PROJECT });
  act(() => {
    view.result.current.setInput('@already selected ');
    view.result.current.setCursorPosition('@already selected '.length);
  });
  assert.equal(getFiles.mock.calls.length, 0);
});

test('an active @ query loads once, keeps its draft across tabs, and selects a file', async () => {
  getFiles.mockResolvedValue(response());
  const view = setup({ isActive: false, project: PROJECT });
  act(() => {
    view.result.current.setInput('Use @i');
    view.result.current.setCursorPosition('Use @i'.length);
  });
  assert.equal(getFiles.mock.calls.length, 0);
  assert.equal(view.result.current.showFileDropdown, false);

  await act(async () => view.rerender({ isActive: true, project: PROJECT }));
  assert.equal(getFiles.mock.calls.length, 1);
  assert.equal(getFiles.mock.calls[0][0], PROJECT.projectId);
  assert.equal(view.result.current.filteredFiles[0].path, 'src/index.ts');

  view.rerender({ isActive: false, project: PROJECT });
  assert.equal(view.result.current.input, 'Use @i');
  assert.equal(view.result.current.showFileDropdown, false);
  view.rerender({ isActive: true, project: PROJECT });
  assert.equal(getFiles.mock.calls.length, 1);
  assert.equal(view.result.current.filteredFiles[0].path, 'src/index.ts');
  act(() => view.result.current.selectFile(view.result.current.filteredFiles[0]));
  assert.equal(view.result.current.input, 'Use src/index.ts ');
  assert.equal(view.result.current.showFileDropdown, false);
  assert.equal(getFiles.mock.calls.length, 1);
});

test('typing does not restart a pending scan and a project switch ignores its old result', async () => {
  let resolveOld!: (result: Response) => void;
  getFiles.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveOld = resolve; }));
  getFiles.mockResolvedValueOnce(response('other.ts'));
  const view = setup();
  act(() => {
    view.result.current.setInput('@');
    view.result.current.setCursorPosition(1);
  });
  const oldSignal = getFiles.mock.calls[0][1]?.signal;
  act(() => {
    view.result.current.setInput('@src');
    view.result.current.setCursorPosition(4);
  });
  assert.equal(getFiles.mock.calls.length, 1);
  await act(async () => view.rerender({ isActive: true, project: OTHER_PROJECT }));
  assert.equal(oldSignal?.aborted, true);
  assert.equal(getFiles.mock.calls.length, 2);
  assert.equal(view.result.current.filteredFiles[0].path, 'src/other.ts');
  await act(async () => resolveOld(response('stale.ts')));
  assert.equal(view.result.current.filteredFiles[0].path, 'src/other.ts');
  assert.equal(getFiles.mock.calls.length, 2);
});

test('a native request still in flight is reused after hiding Chat or temporarily removing @', async () => {
  let resolveFiles!: (result: Response) => void;
  getFiles.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveFiles = resolve; }));
  const view = setup();
  act(() => {
    view.result.current.setInput('@i');
    view.result.current.setCursorPosition(2);
  });
  const signal = getFiles.mock.calls[0][1]?.signal;
  view.rerender({ isActive: false, project: PROJECT });
  view.rerender({ isActive: true, project: PROJECT });
  act(() => {
    view.result.current.setInput('draft');
    view.result.current.setCursorPosition(5);
  });
  act(() => {
    view.result.current.setInput('@i');
    view.result.current.setCursorPosition(2);
  });
  assert.equal(signal?.aborted, false);
  assert.equal(getFiles.mock.calls.length, 1);

  view.rerender({ isActive: false, project: PROJECT });
  await act(async () => resolveFiles(response()));
  assert.equal(view.result.current.showFileDropdown, false);
  view.rerender({ isActive: true, project: PROJECT });
  assert.equal(view.result.current.input, '@i');
  assert.equal(view.result.current.filteredFiles[0].path, 'src/index.ts');
  assert.equal(getFiles.mock.calls.length, 1);
});
